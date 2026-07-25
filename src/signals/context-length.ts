/**
 * Signal: context length.
 *
 * Estimates total prompt size (text parts + attached file contents) and
 * votes for "long_context" when it crosses the configured threshold.
 * Rough heuristic: ~4 characters per token.
 */

import type { Signal } from "../types.ts"

export const contextLengthSignal: Signal = (ctx) => {
  const threshold = ctx.config.signals.contextLength.longChars
  let total = ctx.text.length

  for (const part of ctx.parts) {
    if (part.type === "file" && typeof part.text === "string") total += part.text.length
    if (part.type === "text" && part.synthetic && typeof part.text === "string") total += part.text.length
  }

  if (total < threshold) return null

  const approxTokens = Math.round(total / 4)
  // scale: threshold -> 0.55, 4x threshold -> 1.0
  const strength = Math.min(1, 0.55 + (0.45 * (total - threshold)) / (3 * threshold))

  return {
    votes: { long_context: strength },
    reason: `~${approxTokens.toLocaleString()} tokens of context`,
    metadata: { chars: total, approxTokens },
  }
}
