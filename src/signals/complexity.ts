/**
 * Signal: prompt complexity heuristics.
 *
 * Votes for "trivial" (greetings, one-liners, acknowledgements), "simple"
 * (short single-question prompts) or "reasoning" (long, multi-part,
 * open-ended prompts) without any ML — pure structure + keyword heuristics.
 */

import type { Signal } from "../types.ts"

const TRIVIAL_PATTERNS = [
  /^(hi|hola|hey|hello|yo|sup|buenas|good\s(morning|afternoon|evening)|gracias|thanks|thank\syou|ok(ay)?|vale|perfecto|genial|nice|cool|great|bye|adios|adiós|yes|no|si|sí|nop?|yep|nope)[\s!.?]*$/i,
  /^(lol|jaja(ja)*|xd+)[\s!.?]*$/i,
]

const REASONING_KEYWORDS = [
  "why",
  "por qué",
  "porque",
  "analyze",
  "analiza",
  "analyse",
  "compare",
  "compara",
  "trade-?off",
  "ventajas",
  "desventajas",
  "design",
  "diseña",
  "architect",
  "arquitectura",
  "optimi[sz]e",
  "optimiza",
  "refactor",
  "step by step",
  "paso a paso",
  "pros and cons",
  "evaluate",
  "evalúa",
  "debug",
  "root cause",
  "causa raíz",
  "in depth",
  "en profundidad",
  "explain thoroughly",
  "explica en detalle",
  "strategy",
  "estrategia",
  "plan",
  "planifica",
  "review",
  "revisa",
  "audit",
  "migrat",
  "migra",
  "scale",
  "escala",
]

const COMPLEX_STRUCTURE = /(\n\s*[-*•]\s)|(\n\s*\d+[.)]\s)|(\b(first|second|third|then|finally|primero|segundo|tercero|luego|después|finalmente)\b)/i

export const complexitySignal: Signal = (ctx) => {
  const text = ctx.text.trim()
  if (!text) return null

  const chars = text.length
  const words = text.split(/\s+/).filter(Boolean).length
  const lines = text.split("\n").length
  const questions = (text.match(/\?/g) ?? []).length
  const codeFences = (text.match(/```/g) ?? []).length / 2

  const votes: Record<string, number> = {}
  const reasons: string[] = []

  // --- trivial ------------------------------------------------------------
  if (chars <= 40 && TRIVIAL_PATTERNS.some((p) => p.test(text))) {
    votes["trivial"] = 1
    return { votes, reason: "greeting/acknowledgement" }
  }
  if (words <= 6 && questions === 0 && codeFences === 0 && chars <= 60) {
    votes["trivial"] = Math.max(votes["trivial"] ?? 0, 0.7)
    reasons.push("very short statement")
  }

  // --- simple ---------------------------------------------------------------
  if (words <= 40 && questions <= 1 && lines <= 4 && codeFences === 0) {
    votes["simple"] = 0.65
    reasons.push("short single ask")
  }

  // --- reasoning ------------------------------------------------------------
  let score = 0
  const lower = text.toLowerCase()
  const keywordHits = REASONING_KEYWORDS.filter((k) => new RegExp(k, "i").test(lower)).length
  score += Math.min(keywordHits * 0.22, 0.66)
  if (COMPLEX_STRUCTURE.test(text)) score += 0.2
  if (questions >= 2) score += 0.15
  if (codeFences >= 1) score += 0.1
  if (words > 120) score += 0.15
  else if (words > 60) score += 0.08
  if (lines > 12) score += 0.08

  if (score > 0) {
    votes["reasoning"] = Math.min(score, 1)
    if (score >= 0.4) reasons.push(`complex structure (keywords=${keywordHits}, words=${words})`)
  }

  if (Object.keys(votes).length === 0) {
    votes["simple"] = 0.4 // neutral default
  }

  return { votes, reason: reasons.join("; ") || undefined }
}
