/**
 * Small-AI classifier.
 *
 * Sends the prompt (truncated) to a small, fast, cheap model through any
 * OpenAI-compatible chat-completions endpoint (OpenRouter, Ollama,
 * LM Studio, vLLM, Groq, ...), asking for a strict JSON classification:
 * task type, complexity 1-10, tool need, PII presence.
 *
 * Design goals:
 *   - zero added latency when possible (only called when heuristics are
 *     uncertain, see `classifier.when`)
 *   - never breaks routing: network errors, timeouts, bad JSON -> null
 *   - results cached by prompt hash to avoid duplicate calls
 */

import { createHash } from "node:crypto"
import type { Classification, ClassifierConfig } from "./types.ts"

export const DEFAULT_SYSTEM_PROMPT = `You are a request classifier for an LLM routing system. Analyze the user message and reply with ONLY a minified JSON object, no markdown, no prose:
{"task_type":"...","complexity":N,"needs_tools":B,"contains_pii":B,"reason":"..."}

task_type: one of "chat" (greetings/small talk), "question" (simple factual Q&A), "code" (programming, debugging, config, CLI), "math" (math, logic, formal reasoning), "creative" (writing, brainstorming, marketing), "translation", "summary", "agentic" (multi-step tasks needing tools: run/install/search/edit files), "vision" (about attached images), "other".
complexity: integer 1-10. 1 = a child could answer, 5 = working professional, 10 = world-class expert with multiple steps.
needs_tools: true if a good answer REQUIRES executing code, reading/writing files, shell commands, or web access.
contains_pii: true if the message includes personal data (emails, phone numbers, IDs, credit cards) or credentials (passwords, API keys, tokens).
reason: max 8 words.`

interface CacheEntry {
  value: Classification
  expires: number
}

const MAX_CACHE_ENTRIES = 512
const cache = new Map<string, CacheEntry>()

export function cacheKey(text: string, model: string): string {
  return createHash("sha256").update(`${model}::${text}`).digest("hex")
}

export function cacheGet(key: string): Classification | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    cache.delete(key)
    return null
  }
  return hit.value
}

export function cacheSet(key: string, value: Classification, ttlMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // drop the oldest quarter
    const keys = [...cache.keys()].slice(0, MAX_CACHE_ENTRIES / 4)
    for (const k of keys) cache.delete(k)
  }
  cache.set(key, { value, expires: Date.now() + ttlMs })
}

const VALID_TASK_TYPES = new Set([
  "chat",
  "question",
  "code",
  "math",
  "creative",
  "translation",
  "summary",
  "agentic",
  "vision",
  "other",
])

/** Tolerant extraction of the first JSON object in a string. */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function normalizeClassification(raw: Record<string, unknown>): Classification | null {
  const taskType = typeof raw["task_type"] === "string" ? raw["task_type"].toLowerCase().trim() : "other"
  const complexityRaw = typeof raw["complexity"] === "number" ? raw["complexity"] : Number(raw["complexity"])
  const complexity = Number.isFinite(complexityRaw) ? Math.min(10, Math.max(1, Math.round(complexityRaw))) : 5
  return {
    taskType: VALID_TASK_TYPES.has(taskType) ? taskType : "other",
    complexity,
    needsTools: raw["needs_tools"] === true,
    containsPii: raw["contains_pii"] === true,
    reason: typeof raw["reason"] === "string" ? raw["reason"].slice(0, 120) : undefined,
  }
}

export interface ClassifierCall {
  ok: boolean
  classification?: Classification
  cached: boolean
  latencyMs: number
  error?: string
}

/** Classify by calling an OpenAI-compatible HTTP endpoint directly. */
export async function classifyViaEndpoint(text: string, cfg: ClassifierConfig): Promise<ClassifierCall> {
  const started = Date.now()
  const truncated = text.slice(0, cfg.maxChars)
  const configured = cfg.model
  const modelName = typeof configured === "string" ? configured : Array.isArray(configured) ? configured[0] : undefined
  if (!modelName) {
    return { ok: false, cached: false, latencyMs: Date.now() - started, error: "no concrete classifier model configured" }
  }
  const key = cacheKey(
    truncated,
    typeof configured === "string" ? configured : Array.isArray(configured) ? configured.join(",") : JSON.stringify(configured),
  )

  const cached = cacheGet(key)
  if (cached) return { ok: true, classification: cached, cached: true, latencyMs: Date.now() - started }

  const apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined)
  const base = cfg.baseURL.replace(/\/+$/, "")

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(cfg.headers ?? {}),
  }

  const body = {
    model: modelName,
    messages: [
      { role: "system", content: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: truncated },
    ],
    temperature: 0,
    max_tokens: 150,
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: `HTTP ${res.status}` }
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: "empty response" }
    }

    const raw = extractJson(content)
    if (!raw) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: "no JSON in response" }
    }

    const classification = normalizeClassification(raw)
    if (!classification) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: "invalid classification" }
    }

    cacheSet(key, classification, cfg.cacheTtlMinutes * 60_000)
    return { ok: true, classification, cached: false, latencyMs: Date.now() - started }
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError" ? `timeout after ${cfg.timeoutMs}ms` : err instanceof Error ? err.message : String(err)
    return { ok: false, cached: false, latencyMs: Date.now() - started, error: message }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Test hook: empty the classification cache. */
export function __clearClassifierCache(): void {
  cache.clear()
}
