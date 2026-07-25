/**
 * Signal: user-defined custom rules.
 *
 * Rules are regexes evaluated against the raw prompt text. A matching rule
 * either casts a weighted vote for its category, or — with `veto: true` —
 * hard-routes the message, bypassing every other signal. Rules are the
 * highest-priority signal: they run first and their vetoes beat all others.
 */

import type { CustomRule, Signal } from "../types.ts"

interface CompiledRule {
  rule: CustomRule
  re: RegExp | null
}

function compile(rule: CustomRule): CompiledRule {
  try {
    return { rule, re: new RegExp(rule.match, rule.flags ?? "i") }
  } catch {
    return { rule, re: null }
  }
}

export const rulesSignal: Signal = (ctx) => {
  const cfg = ctx.config.signals.rules
  if (!cfg.enabled || cfg.list.length === 0) return null

  const votes: Record<string, number> = {}
  const reasons: string[] = []

  for (const { rule, re } of cfg.list.map(compile)) {
    if (!re) continue
    if (!re.test(ctx.text)) continue

    const label = rule.name ?? rule.match
    if (rule.veto) {
      return {
        veto: { category: rule.route, reason: `custom rule "${label}" matched` },
        reason: `rule "${label}" (veto)`,
      }
    }

    const strength = Math.min(1, (rule.weight ?? cfg.weight) / 3)
    votes[rule.route] = Math.max(votes[rule.route] ?? 0, strength)
    reasons.push(`rule "${label}"`)
  }

  if (Object.keys(votes).length === 0) return null
  return { votes, reason: reasons.join("; ") }
}
