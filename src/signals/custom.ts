/**
 * Signal: user-provided custom signal plugins.
 *
 * `signals.custom.paths` lists JS/TS modules (relative to the project
 * directory or absolute). Each module must export a signal function either
 * as the default export or as a named `signal` export:
 *
 *   // .opencode/signals/my-signal.ts
 *   export default function (ctx) {
 *     if (/kubernetes|k8s/i.test(ctx.text))
 *       return { votes: { code: 0.9 }, reason: "k8s topic" }
 *     return null
 *   }
 *
 * Modules that fail to load or execute are skipped with a warning — a
 * broken custom signal must never break routing.
 */

import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Signal, SignalContext, SignalResult } from "../types.ts"

interface LoadedSignal {
  path: string
  fn: Signal
}

let cache: Map<string, LoadedSignal[] | null> | null = null

async function loadModule(path: string, directory: string): Promise<LoadedSignal | null> {
  const full = isAbsolute(path) ? path : resolve(directory, path)
  try {
    const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>
    const fn = (mod["default"] ?? mod["signal"]) as unknown
    if (typeof fn !== "function") {
      console.warn(`[llm-router] custom signal ${path}: no default/signal function export, skipped`)
      return null
    }
    return { path, fn: fn as Signal }
  } catch (err) {
    console.warn(`[llm-router] custom signal ${path}: failed to load (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

async function loadAll(paths: string[], directory: string): Promise<LoadedSignal[]> {
  const key = `${directory}::${paths.join(",")}`
  if (!cache) cache = new Map()
  const hit = cache.get(key)
  if (hit !== undefined && hit !== null) return hit
  const loaded = (await Promise.all(paths.map((p) => loadModule(p, directory)))).filter(
    (s): s is LoadedSignal => s !== null,
  )
  cache.set(key, loaded)
  return loaded
}

function isValidResult(value: unknown): value is SignalResult {
  if (value === null) return true
  if (typeof value !== "object" || value === undefined) return false
  const v = value as Record<string, unknown>
  if (v["votes"] !== undefined && (typeof v["votes"] !== "object" || v["votes"] === null)) return false
  return true
}

export function createCustomSignal(): Signal {
  return async (ctx: SignalContext) => {
    const cfg = ctx.config.signals.custom
    if (!cfg.enabled || cfg.paths.length === 0) return null

    const signals = await loadAll(cfg.paths, ctx.directory)
    const votes: Record<string, number> = {}
    const reasons: string[] = []

    for (const { path, fn } of signals) {
      try {
        const result = await fn(ctx)
        if (!isValidResult(result) || result === null) continue
        if (result.veto) return { veto: result.veto, reason: result.reason ?? `custom signal ${path}` }
        for (const [cat, score] of Object.entries(result.votes ?? {})) {
          if (typeof score !== "number" || Number.isNaN(score)) continue
          votes[cat] = Math.max(votes[cat] ?? 0, Math.min(1, Math.max(0, score)))
        }
        if (result.reason) reasons.push(`${path}: ${result.reason}`)
      } catch (err) {
        console.warn(`[llm-router] custom signal ${path} threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (Object.keys(votes).length === 0) return null
    return { votes, reason: reasons.join("; ") || undefined }
  }
}

/** Test hook: clear the module cache. */
export function __resetCustomForTests(): void {
  cache = null
}
