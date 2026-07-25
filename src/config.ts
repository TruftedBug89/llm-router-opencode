/**
 * Configuration loading for opencode-llm-router.
 *
 * Merge order (lowest to highest priority):
 *   defaults  <  global file  <  project file  <  inline plugin options
 *
 *   global:   ~/.config/opencode/llm-router.json   ($XDG_CONFIG_HOME honored)
 *   project:  <project>/.opencode/llm-router.json
 *   inline:   ["opencode-llm-router", { ... }] tuple in opencode.json
 *
 * Files may contain JSONC (comments + trailing commas). Any string value of
 * the form "{env:VAR_NAME}" is replaced by that environment variable.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { RouterConfig } from "./types.ts"

export const CONFIG_FILENAME = "llm-router.json"
export const CONFIG_ENV_OVERRIDE = "OPENCODE_LLM_ROUTER_CONFIG"

export const CLASSIFIER_AGENT = "llm-router-classifier"
export const ROUTER_AGENT = "auto-router"
export const ROUTER_COMMAND = "router"

export const DEFAULT_CONFIG: RouterConfig = {
  mode: "auto",
  // Default routes target the opencode catalog: Go subscription models first,
  // then zen, then zen FREE models — the first model available in YOUR catalog
  // wins, so this works out of the box with zero configuration.
  routes: {
    trivial: ["opencode/mimo-v2.5-free", "opencode/big-pickle", "opencode/deepseek-v4-flash-free"],
    simple: ["opencode/big-pickle", "opencode/mimo-v2.5-free", "opencode/deepseek-v4-flash-free"],
    code: ["opencode-go/kimi-k2.7-code", "opencode/kimi-k2.7-code", "opencode/big-pickle"],
    reasoning: ["opencode-go/kimi-k3", "opencode/kimi-k2.6", "opencode/nemotron-3-ultra-free"],
    creative: ["opencode-go/qwen3.7-plus", "opencode/glm-5.1", "opencode/big-pickle"],
    vision: ["opencode-go/mimo-v2.5", "opencode-go/kimi-k2.5"],
    agentic: ["opencode-go/kimi-k2.7-code", "opencode/kimi-k2.7-code", "opencode/big-pickle"],
    long_context: ["opencode/nemotron-3-ultra-free", "opencode-go/mimo-v2.5", "opencode/mimo-v2.5-free"],
    // NOTE: free zen models are still cloud models. For true privacy point this
    // at a local model, e.g. "ollama/qwen3:8b".
    private: ["opencode/mimo-v2.5-free", "opencode/big-pickle"],
  },
  minConfidence: 0.4,
  onlyAgents: [ROUTER_AGENT],
  skipAgents: [CLASSIFIER_AGENT],
  respectVariant: true,
  notify: true,
  classifier: {
    enabled: true,
    source: "opencode",
    model: ["opencode/big-pickle", "opencode/mimo-v2.5-free", "opencode/deepseek-v4-flash-free"],
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    timeoutMs: 6000,
    maxChars: 4000,
    weight: 2,
    when: "uncertain",
    uncertainMargin: 0.15,
    cacheTtlMinutes: 60,
  },
  signals: {
    complexity: { enabled: true, weight: 1 },
    taskType: { enabled: true, weight: 1 },
    contextLength: { enabled: true, weight: 1, longChars: 24000 },
    toolsNeeded: { enabled: true, weight: 1 },
    pii: { enabled: true, action: "route", route: "private" },
    rules: { enabled: true, weight: 3, list: [] },
    bert: {
      enabled: false,
      model: "Xenova/distilbert-base-uncased-mnli",
      labels: [
        "trivial small talk",
        "simple question",
        "programming or code",
        "advanced math or logical reasoning",
        "creative writing",
        "multi-step task requiring tools",
      ],
      labelMap: {
        "trivial small talk": "trivial",
        "simple question": "simple",
        "programming or code": "code",
        "advanced math or logical reasoning": "reasoning",
        "creative writing": "creative",
        "multi-step task requiring tools": "agentic",
      },
      weight: 1.5,
      maxChars: 2000,
    },
    custom: { enabled: true, weight: 1, paths: [] },
  },
  log: { enabled: true, maxBytes: 5 * 1024 * 1024 },
  debug: false,
}

/** Remove // and block comments plus trailing commas (tolerant JSONC). */
export function stripJsonc(input: string): string {
  let out = ""
  let inString = false
  let quote = ""
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i++
      continue
    }
    out += ch
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Deep-merge `partial` over `base`. Arrays and plain objects merge per spec:
 *  objects merge key-wise, arrays are replaced, scalars are replaced. */
export function deepMerge<T>(base: T, partial: unknown): T {
  if (partial === undefined || partial === null) return base
  if (Array.isArray(partial)) return partial as T
  if (typeof partial === "object" && typeof base === "object" && base !== null && !Array.isArray(base)) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
      result[key] = key in result ? deepMerge(result[key], value) : value
    }
    return result as T
  }
  return partial as T
}

/** Recursively replace string values shaped exactly like "{env:VAR}". */
export function interpolateEnv<T>(value: T): T {
  if (typeof value === "string") {
    const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
    if (m) return (process.env[m[1]!] ?? "") as T
    return value
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateEnv(v)
    return out as T
  }
  return value
}

export function globalConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "opencode")
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), CONFIG_FILENAME)
}

export function projectConfigPath(directory: string): string {
  return join(directory, ".opencode", CONFIG_FILENAME)
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8")
    const parsed: unknown = JSON.parse(stripJsonc(raw))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`[llm-router] ${path}: expected a JSON object, ignoring file`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    warnings.push(`[llm-router] ${path}: failed to parse (${err instanceof Error ? err.message : String(err)}), ignoring file`)
    return null
  }
}

/** Light sanity checks. Returns human-readable warnings; never throws. */
export function validateConfig(config: RouterConfig): string[] {
  const warnings: string[] = []
  if (!["auto", "suggest", "off"].includes(config.mode)) {
    warnings.push(`[llm-router] invalid mode "${String(config.mode)}", falling back to "auto"`)
    config.mode = "auto"
  }
  if (!(config.minConfidence >= 0 && config.minConfidence <= 1)) {
    warnings.push(`[llm-router] minConfidence must be in [0,1], using 0.4`)
    config.minConfidence = 0.4
  }
  if (config.classifier.enabled && config.classifier.source === "endpoint" && !config.classifier.baseURL) {
    warnings.push(`[llm-router] classifier.source is "endpoint" but baseURL is empty; classifier disabled`)
    config.classifier.enabled = false
  }
  if (config.signals.pii.action === "route" && !config.routes[config.signals.pii.route]) {
    warnings.push(
      `[llm-router] PII routing is on but routes["${config.signals.pii.route}"] is not set; PII will be detected but not rerouted`,
    )
  }
  for (const rule of config.signals.rules.list) {
    try {
      new RegExp(rule.match, rule.flags ?? "i")
    } catch {
      warnings.push(`[llm-router] rule "${rule.name ?? rule.match}" has an invalid regex and will be skipped`)
    }
  }
  return warnings
}

export interface LoadedConfig {
  config: RouterConfig
  /** Files that actually contributed to the final config. */
  sources: string[]
  warnings: string[]
}

export function loadConfig(directory: string, inline?: Record<string, unknown>): LoadedConfig {
  const warnings: string[] = []
  const sources: string[] = []

  let merged: unknown = DEFAULT_CONFIG

  const override = process.env[CONFIG_ENV_OVERRIDE]
  const candidates = override
    ? [override]
    : [globalConfigPath(), projectConfigPath(directory)]

  for (const path of candidates) {
    const file = readConfigFile(path, warnings)
    if (file) {
      merged = deepMerge(merged, file)
      sources.push(path)
    }
  }

  if (inline && Object.keys(inline).length > 0) {
    merged = deepMerge(merged, inline)
    sources.push("<inline plugin options>")
  }

  const config = interpolateEnv(merged) as RouterConfig
  warnings.push(...validateConfig(config))
  return { config, sources, warnings }
}
