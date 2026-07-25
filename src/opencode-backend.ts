/**
 * Small-AI classifier through opencode itself.
 *
 * Instead of an external HTTP endpoint, this backend asks a model from the
 * user's OWN opencode catalog (zen / Go / free models) via the SDK:
 *
 *   session.create → session.prompt (system prompt + text, tools off,
 *   single step) → read the JSON reply → session.delete
 *
 * Sessions created here are tracked so the router never tries to route the
 * classifier's own messages, and every call is bounded by a timeout that
 * aborts + deletes the session. Any failure degrades to "no classification"
 * and routing continues with local signals only.
 */

import {
  DEFAULT_SYSTEM_PROMPT,
  cacheGet,
  cacheKey,
  cacheSet,
  extractJson,
  normalizeClassification,
  type ClassifierCall,
} from "./classifier.ts"
import type { ClassifierConfig, ModelRef } from "./types.ts"

/** Tools explicitly disabled for the one-shot classification call. */
const TOOLS_OFF: Record<string, boolean> = {
  bash: false,
  edit: false,
  write: false,
  patch: false,
  task: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  skill: false,
  question: false,
  read: false,
  glob: false,
  grep: false,
  list: false,
  lsp: false,
}

const activeSessions = new Set<string>()

/** True while a classification prompt is running inside this session. */
export function isClassifierSession(sessionID: string): boolean {
  return activeSessions.has(sessionID)
}

/** Minimal structural view of the opencode SDK client (defensive). */
export interface OpencodeClientLike {
  session: {
    create(options: unknown): Promise<unknown>
    prompt(options: unknown): Promise<unknown>
    delete(options: unknown): Promise<unknown>
    abort(options: unknown): Promise<unknown>
  }
}

function unwrap(payload: unknown): Record<string, unknown> {
  // hey-api clients resolve to { data, error }; plain fetches to the body.
  if (payload !== null && typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    if ("error" in obj && obj["error"] && !obj["data"]) {
      const err = obj["error"] as Record<string, unknown>
      const message =
        (err["data"] as Record<string, unknown> | undefined)?.["message"] ?? err["message"] ?? "opencode API error"
      throw new Error(String(message))
    }
    if ("data" in obj) return (obj["data"] ?? {}) as Record<string, unknown>
    return obj
  }
  return {}
}

function textFromParts(payload: Record<string, unknown>): string {
  const parts = payload["parts"]
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
    .filter((p) => p["type"] === "text" && typeof p["text"] === "string")
    .map((p) => p["text"] as string)
    .join("\n")
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function classifyViaOpencode(
  client: OpencodeClientLike,
  text: string,
  cfg: ClassifierConfig,
  model: ModelRef,
  agent: string,
): Promise<ClassifierCall> {
  const started = Date.now()
  const truncated = text.slice(0, cfg.maxChars)
  const key = cacheKey(truncated, `opencode:${model.providerID}/${model.modelID}`)

  const cached = cacheGet(key)
  if (cached) return { ok: true, classification: cached, cached: true, latencyMs: Date.now() - started }

  let sessionID: string | undefined
  try {
    const created = unwrap(await client.session.create({ body: { title: "llm-router classify" } }))
    sessionID = typeof created["id"] === "string" ? created["id"] : undefined
    if (!sessionID) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: "could not create classifier session" }
    }
    activeSessions.add(sessionID)

    const replied = unwrap(
      await withTimeout(
        client.session.prompt({
          path: { id: sessionID },
          body: {
            agent,
            model: { providerID: model.providerID, modelID: model.modelID },
            system: cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
            tools: TOOLS_OFF,
            parts: [{ type: "text", text: truncated }],
          },
        }),
        cfg.timeoutMs,
      ),
    )

    const content = textFromParts(replied)
    if (!content) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: "empty classifier response" }
    }
    const raw = extractJson(content)
    const classification = raw ? normalizeClassification(raw) : null
    if (!classification) {
      return { ok: false, cached: false, latencyMs: Date.now() - started, error: "no JSON in classifier response" }
    }

    cacheSet(key, classification, cfg.cacheTtlMinutes * 60_000)
    return { ok: true, classification, cached: false, latencyMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      cached: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (sessionID) {
      activeSessions.delete(sessionID)
      // best-effort cleanup; never blocks routing
      void client.session
        .abort({ path: { id: sessionID } })
        .catch(() => {})
        .then(() => client.session.delete({ path: { id: sessionID } }))
        .catch(() => {})
    }
  }
}
