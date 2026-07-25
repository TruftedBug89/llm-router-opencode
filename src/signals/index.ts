/**
 * Signal registry + runner.
 *
 * Runs every enabled signal (local heuristics first — they are free), then
 * optionally the small-AI classifier. Each signal is isolated: a throwing
 * signal is caught and reported, never breaking the routing pipeline.
 */

import type { Signal, SignalContext, SignalOutcome } from "../types.ts"
import { complexitySignal } from "./complexity.ts"
import { taskTypeSignal } from "./task-type.ts"
import { contextLengthSignal } from "./context-length.ts"
import { toolsNeededSignal } from "./tools-needed.ts"
import { piiSignal } from "./pii.ts"
import { rulesSignal } from "./rules.ts"
import { bertSignal } from "./bert.ts"
import { createCustomSignal } from "./custom.ts"

interface RegistryEntry {
  name: string
  signal: Signal
  enabled: (ctx: SignalContext) => boolean
  weight: (ctx: SignalContext) => number
}

export function localSignals(): RegistryEntry[] {
  return [
    {
      name: "rules",
      signal: rulesSignal,
      enabled: (c) => c.config.signals.rules.enabled && c.config.signals.rules.list.length > 0,
      weight: (c) => c.config.signals.rules.weight,
    },
    {
      name: "pii",
      signal: piiSignal,
      enabled: (c) => c.config.signals.pii.enabled && c.config.signals.pii.action !== "off",
      weight: () => 1, // PII works through vetoes, not votes
    },
    {
      name: "tools-needed",
      signal: toolsNeededSignal,
      enabled: (c) => c.config.signals.toolsNeeded.enabled,
      weight: (c) => c.config.signals.toolsNeeded.weight,
    },
    {
      name: "complexity",
      signal: complexitySignal,
      enabled: (c) => c.config.signals.complexity.enabled,
      weight: (c) => c.config.signals.complexity.weight,
    },
    {
      name: "task-type",
      signal: taskTypeSignal,
      enabled: (c) => c.config.signals.taskType.enabled,
      weight: (c) => c.config.signals.taskType.weight,
    },
    {
      name: "context-length",
      signal: contextLengthSignal,
      enabled: (c) => c.config.signals.contextLength.enabled,
      weight: (c) => c.config.signals.contextLength.weight,
    },
    {
      name: "bert",
      signal: bertSignal,
      enabled: (c) => c.config.signals.bert.enabled,
      weight: (c) => c.config.signals.bert.weight,
    },
    {
      name: "custom",
      signal: createCustomSignal(),
      enabled: (c) => c.config.signals.custom.enabled && c.config.signals.custom.paths.length > 0,
      weight: (c) => c.config.signals.custom.weight,
    },
  ]
}

export async function runLocalSignals(ctx: SignalContext): Promise<SignalOutcome[]> {
  const entries = localSignals().filter((e) => {
    try {
      return e.enabled(ctx)
    } catch {
      return false
    }
  })

  return Promise.all(
    entries.map(async (entry): Promise<SignalOutcome> => {
      const started = Date.now()
      try {
        const result = await entry.signal(ctx)
        return { name: entry.name, weight: entry.weight(ctx), result, latencyMs: Date.now() - started }
      } catch (err) {
        return {
          name: entry.name,
          weight: entry.weight(ctx),
          result: null,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )
}
