/**
 * Signal: BERT zero-shot classifier (optional, local ML).
 *
 * Uses `@huggingface/transformers` (transformers.js) to run a zero-shot
 * classification model fully locally. This is a heavyweight dependency, so
 * it is:
 *   - disabled by default (`signals.bert.enabled: false`)
 *   - loaded lazily on first use via dynamic import
 *   - an optional peer dependency; if it is not installed the signal
 *     disables itself with a single warning instead of crashing.
 */

import type { Signal } from "../types.ts"

type ZeroShotOutput = { sequence: string; labels: string[]; scores: number[] }
type Pipeline = (text: string, labels: string[]) => Promise<ZeroShotOutput>

// Indirect specifier so TypeScript does not resolve the optional dependency.
const TRANSFORMERS_SPECIFIER = "@huggingface/transformers"

let pipelinePromise: Promise<Pipeline | null> | null = null
let warned = false

async function loadPipeline(model: string): Promise<Pipeline | null> {
  pipelinePromise ??= (async () => {
    try {
      const mod = (await import(TRANSFORMERS_SPECIFIER)) as {
        pipeline: (task: string, m: string) => Promise<unknown>
      }
      const pipe = (await mod.pipeline("zero-shot-classification", model)) as Pipeline
      return pipe
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(
          `[llm-router] BERT signal unavailable (${err instanceof Error ? err.message : String(err)}). ` +
            `Install the optional dependency with: npm i @huggingface/transformers`,
        )
      }
      return null
    }
  })()
  return pipelinePromise
}

export const bertSignal: Signal = async (ctx) => {
  const cfg = ctx.config.signals.bert
  if (!cfg.enabled) return null
  const text = ctx.text.trim().slice(0, cfg.maxChars)
  if (!text) return null

  const pipe = await loadPipeline(cfg.model)
  if (!pipe) return null

  try {
    const out = await pipe(text, cfg.labels)
    const votes: Record<string, number> = {}
    for (let i = 0; i < out.labels.length; i++) {
      const category = cfg.labelMap[out.labels[i]!]
      if (!category) continue
      const score = out.scores[i] ?? 0
      votes[category] = Math.max(votes[category] ?? 0, score)
    }
    if (Object.keys(votes).length === 0) return null
    const top = out.labels[0]
    return {
      votes,
      reason: `bert: "${top}" (${((out.scores[0] ?? 0) * 100).toFixed(0)}%)`,
      metadata: { labels: out.labels, scores: out.scores },
    }
  } catch (err) {
    if (!warned) {
      warned = true
      console.warn(`[llm-router] BERT classification failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
}

/** Test hook: reset the cached pipeline between test runs. */
export function __resetBertForTests(): void {
  pipelinePromise = null
  warned = false
}
