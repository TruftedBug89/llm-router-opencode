/**
 * Fusion router.
 *
 * Decision pipeline (many signals at once):
 *
 *   1. local signal outcomes (already executed) contribute weighted votes
 *   2. vetoes are applied by priority: custom rules > PII > custom signals
 *      > hard requirements (vision)
 *   3. if the vote margin is too small (or `classifier.when === "always"`),
 *      the small AI is called and adds its own weighted votes
 *   4. capability-aware adjustments (current model already supports vision?
 *      context window already large enough? route target actually available?)
 *   5. the winning category is mapped through `routes` — "keep" when the
 *      confidence is too low or no route is configured
 *
 * Everything in here is pure/portable: no opencode SDK imports, so the
 * whole engine is unit-testable with node:test.
 */

import type { ClassifierCall } from "./classifier.ts"
import type {
  CapabilitiesLookup,
  CatalogEntry,
  CatalogLister,
  Category,
  Classification,
  ClassifierConfig,
  Decision,
  ModelRef,
  ModelSelector,
  RouteModel,
  RouteParams,
  RouteTarget,
  SignalContext,
  SignalOutcome,
  Veto,
} from "./types.ts"

export type ClassifyFn = (text: string, cfg: ClassifierConfig) => Promise<ClassifierCall>

export interface DecideInput {
  ctx: SignalContext
  outcomes: SignalOutcome[]
  classifyFn?: ClassifyFn
  capabilities?: CapabilitiesLookup
  catalog?: CatalogLister
}

/** task_type from the small AI -> route category */
const CLASSIFIER_CATEGORY_MAP: Record<string, Category> = {
  chat: "trivial",
  question: "simple",
  code: "code",
  math: "reasoning",
  creative: "creative",
  translation: "simple",
  summary: "simple",
  agentic: "agentic",
  vision: "vision",
  other: "simple",
}

/** Veto priority, lowest index wins. */
const VETO_PRIORITY = ["rules", "pii", "custom", "tools-needed"]

export function parseModelRef(ref: string): ModelRef | null {
  // model IDs may themselves contain slashes (e.g. openrouter/google/gemini-2.5-flash)
  const idx = ref.indexOf("/")
  if (idx <= 0 || idx === ref.length - 1) return null
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) }
}

export function normalizeRouteTarget(route: string | string[] | RouteTarget): RouteTarget {
  if (typeof route === "string") return { model: route }
  if (Array.isArray(route)) return { model: route }
  return route
}

export interface ModelResolution {
  model: ModelRef
  /** Candidates skipped because they are unavailable (or malformed). */
  skipped: string[]
}

/**
 * Pick a model from the live catalog using a selector. Deprecated models are
 * always excluded. Returns null when nothing matches.
 */
export function selectModel(selector: ModelSelector, catalog: CatalogEntry[]): ModelResolution | null {
  let candidates = catalog.filter((e) => e.caps.status !== "deprecated")
  if (selector.freeOnly) candidates = candidates.filter((e) => e.caps.free === true)
  if (selector.vision) candidates = candidates.filter((e) => e.caps.imageInput === true)
  if (selector.minContext !== undefined) {
    candidates = candidates.filter((e) => (e.caps.contextLimit ?? 0) >= selector.minContext!)
  }
  if (selector.providers && selector.providers.length > 0) {
    const allowed = new Set(selector.providers)
    candidates = candidates.filter((e) => allowed.has(e.providerID))
  }
  if (candidates.length === 0) return null

  const order = (entries: CatalogEntry[]): CatalogEntry[] => {
    const sorted = [...entries]
    if (selector.providers && selector.providers.length > 0) {
      const priority = new Map(selector.providers.map((p, i) => [p, i]))
      sorted.sort((a, b) => (priority.get(a.providerID) ?? 99) - (priority.get(b.providerID) ?? 99))
    }
    if (selector.pick === "largest") {
      sorted.sort((a, b) => (b.caps.contextLimit ?? 0) - (a.caps.contextLimit ?? 0))
    } else if (selector.pick === "smallest") {
      sorted.sort((a, b) => (a.caps.contextLimit ?? 0) - (b.caps.contextLimit ?? 0))
    }
    return sorted
  }

  for (const pattern of selector.prefer ?? []) {
    let re: RegExp
    try {
      re = new RegExp(pattern, "i")
    } catch {
      continue
    }
    const matches = candidates.filter((e) => re.test(`${e.providerID}/${e.modelID}`) || (e.caps.name !== undefined && re.test(e.caps.name)))
    const best = order(matches)[0]
    if (best) return { model: { providerID: best.providerID, modelID: best.modelID }, skipped: [] }
  }

  const best = order(candidates)[0]!
  return { model: { providerID: best.providerID, modelID: best.modelID }, skipped: [] }
}

/**
 * Resolve a route target into a concrete model:
 *   - { auto: selector }  -> dynamic pick from the live catalog
 *   - "a/x" | ["a/x", …]  -> first available candidate (optimistic first
 *     when no catalog is loaded). "keep" entries are skipped.
 * Returns null when nothing is usable.
 */
export function resolveModel(
  target: RouteModel,
  capabilities?: CapabilitiesLookup,
  catalog?: CatalogLister,
): ModelResolution | null {
  if (typeof target === "object" && !Array.isArray(target) && "auto" in target) {
    if (!catalog) return null
    return selectModel(target.auto, catalog())
  }

  const candidates = (Array.isArray(target) ? target : [target]).filter((c) => c !== "keep")
  const skipped: string[] = []
  for (const candidate of candidates) {
    const ref = parseModelRef(candidate)
    if (!ref) {
      skipped.push(candidate)
      continue
    }
    if (!capabilities) return { model: ref, skipped }
    const caps = capabilities(ref)
    if (caps?.exists === false) {
      skipped.push(candidate)
      continue
    }
    return { model: ref, skipped }
  }
  return null
}

function classifierVotes(c: Classification): Record<Category, number> {
  const votes: Record<Category, number> = {}
  const category = CLASSIFIER_CATEGORY_MAP[c.taskType] ?? "simple"
  votes[category] = 0.85

  if (c.complexity >= 8) votes["reasoning"] = Math.max(votes["reasoning"] ?? 0, 0.6)
  else if (c.complexity <= 2) votes["trivial"] = Math.max(votes["trivial"] ?? 0, 0.6)
  else if (c.complexity <= 4) votes["simple"] = Math.max(votes["simple"] ?? 0, 0.4)

  if (c.needsTools) votes["agentic"] = Math.max(votes["agentic"] ?? 0, 0.4)
  if (c.containsPii) votes["private"] = Math.max(votes["private"] ?? 0, 0.9)
  return votes
}

function addVotes(scores: Record<Category, number>, votes: Record<Category, number>, weight: number): void {
  for (const [category, vote] of Object.entries(votes)) {
    if (typeof vote !== "number" || Number.isNaN(vote) || vote <= 0) continue
    scores[category] = (scores[category] ?? 0) + weight * Math.min(1, vote)
  }
}

interface Scoring {
  scores: Record<Category, number>
  total: number
  best?: { category: Category; score: number }
  second: number
  confidence: number
  margin: number
}

function computeScoring(scores: Record<Category, number>): Scoring {
  let total = 0
  let best: { category: Category; score: number } | undefined
  let second = 0
  for (const [category, score] of Object.entries(scores)) {
    total += score
    if (!best || score > best.score) {
      second = best?.score ?? 0
      best = { category, score }
    } else if (score > second) {
      second = score
    }
  }
  const confidence = total > 0 && best ? best.score / total : 0
  const margin = total > 0 && best ? (best.score - second) / total : 0
  return { scores, total, best, second, confidence, margin }
}

function pickVeto(outcomes: SignalOutcome[]): { veto: Veto; from: string } | null {
  const withVeto = outcomes.filter((o) => o.result?.veto)
  if (withVeto.length === 0) return null
  withVeto.sort((a, b) => {
    const pa = VETO_PRIORITY.indexOf(a.name)
    const pb = VETO_PRIORITY.indexOf(b.name)
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
  })
  const winner = withVeto[0]!
  return { veto: winner.result!.veto!, from: winner.name }
}

function baseDecision(partial: Partial<Decision> & { reason: string }): Decision {
  return {
    action: "keep",
    confidence: 0,
    scores: {},
    classifierUsed: false,
    signals: [],
    latencyMs: 0,
    ...partial,
  }
}

export async function decide(input: DecideInput): Promise<Decision> {
  const started = Date.now()
  const { ctx, outcomes, capabilities } = input
  const cfg = ctx.config

  const signalsSummary = outcomes
    .filter((o) => o.result?.reason)
    .map((o) => ({ name: o.name, reason: o.result!.reason }))

  // -- 1. aggregate local votes ------------------------------------------
  const scores: Record<Category, number> = {}
  for (const outcome of outcomes) {
    if (outcome.result?.votes) addVotes(scores, outcome.result.votes, outcome.weight)
  }
  let scoring = computeScoring(scores)

  // -- 2. vetoes ----------------------------------------------------------
  const vetoPick = pickVeto(outcomes)
  let veto = vetoPick?.veto
  let vetoedBy = vetoPick?.from

  // vision veto only matters if the current model cannot see images
  if (veto && veto.category === "vision" && ctx.currentModel && capabilities) {
    const caps = capabilities(ctx.currentModel)
    if (caps?.imageInput === true) {
      veto = undefined
      vetoedBy = undefined
    }
  }

  // -- 3. small-AI classifier (only when it adds value) --------------------
  let classification: Classification | undefined
  let classifierUsed = false
  const classifierCfg = cfg.classifier
  const shouldClassify =
    !veto &&
    classifierCfg.enabled &&
    input.classifyFn !== undefined &&
    ctx.text.trim().length > 0 &&
    (classifierCfg.when === "always" || scoring.total === 0 || scoring.margin < classifierCfg.uncertainMargin)

  if (shouldClassify && input.classifyFn) {
    const call = await input.classifyFn(ctx.text, classifierCfg)
    if (call.ok && call.classification) {
      classifierUsed = true
      classification = call.classification
      addVotes(scores, classifierVotes(classification), classifierCfg.weight)
      scoring = computeScoring(scores)
      signalsSummary.push({
        name: "small-ai",
        reason: `${classification.taskType}/${classification.complexity}${classification.reason ? ` — ${classification.reason}` : ""}${call.cached ? " (cached)" : ""}`,
      })
    } else if (cfg.debug) {
      signalsSummary.push({ name: "small-ai", reason: `unavailable: ${call.error ?? "unknown"}` })
    }
  }

  // -- 4. choose category --------------------------------------------------
  let category: Category | undefined = veto?.category ?? scoring.best?.category
  let confidence = veto ? 1 : scoring.confidence

  // PII veto with no configured route degrades to a normal decision
  const piiRouteMissing =
    veto && vetoedBy === "pii" && cfg.routes[veto.category] === undefined

  if (veto && piiRouteMissing) {
    category = scoring.best?.category
    confidence = scoring.confidence
    veto = undefined
    vetoedBy = undefined
  }

  const finish = (d: Decision): Decision => ({ ...d, latencyMs: Date.now() - started })

  if (!category) {
    return finish(
      baseDecision({
        reason: "no signal fired; keeping current model",
        scores: scoring.scores,
        classifierUsed,
        classification,
        signals: signalsSummary,
      }),
    )
  }

  // -- 5. confidence gate --------------------------------------------------
  if (!veto && confidence < cfg.minConfidence) {
    return finish(
      baseDecision({
        category,
        reason: `low confidence (${confidence.toFixed(2)} < ${cfg.minConfidence}); keeping current model`,
        confidence,
        scores: scoring.scores,
        classifierUsed,
        classification,
        signals: signalsSummary,
      }),
    )
  }

  // -- 6. long_context is only a problem if the model can't fit it ---------
  if (category === "long_context" && ctx.currentModel && capabilities) {
    const caps = capabilities(ctx.currentModel)
    const approxTokens = outcomes.find((o) => o.name === "context-length")?.result?.metadata?.["approxTokens"]
    if (
      caps?.contextLimit !== undefined &&
      typeof approxTokens === "number" &&
      caps.contextLimit >= approxTokens * 1.2
    ) {
      return finish(
        baseDecision({
          category,
          reason: `current model already fits ~${approxTokens} tokens; keeping it`,
          confidence,
          scores: scoring.scores,
          classifierUsed,
          classification,
          signals: signalsSummary,
        }),
      )
    }
  }

  // -- 7. resolve the route -------------------------------------------------
  const route = cfg.routes[category]
  if (!route) {
    return finish(
      baseDecision({
        category,
        reason: `category "${category}" has no route configured; keeping current model`,
        confidence,
        scores: scoring.scores,
        vetoedBy,
        classifierUsed,
        classification,
        signals: signalsSummary,
      }),
    )
  }

  const target = normalizeRouteTarget(route)
  const isKeep = Array.isArray(target.model) ? target.model.every((m) => m === "keep") : target.model === "keep"
  if (isKeep) {
    return finish(
      baseDecision({
        category,
        reason: `route for "${category}" is "keep"`,
        confidence,
        scores: scoring.scores,
        vetoedBy,
        classifierUsed,
        classification,
        signals: signalsSummary,
      }),
    )
  }

  // -- 8. resolve the route target against the live model catalog ----------
  const resolution = resolveModel(target.model, capabilities, input.catalog)
  if (!resolution) {
    return finish(
      baseDecision({
        category,
        reason: `no available model for "${category}"; keeping current model`,
        confidence,
        scores: scoring.scores,
        vetoedBy,
        classifierUsed,
        classification,
        signals: signalsSummary,
      }),
    )
  }
  const model = resolution.model

  // -- 9. no-op if we would route to the model already in use --------------
  if (ctx.currentModel && ctx.currentModel.providerID === model.providerID && ctx.currentModel.modelID === model.modelID) {
    return finish(
      baseDecision({
        category,
        reason: `already on the target model for "${category}"`,
        confidence,
        scores: scoring.scores,
        vetoedBy,
        classifierUsed,
        classification,
        signals: signalsSummary,
      }),
    )
  }

  const fallbackNote =
    resolution.skipped.length > 0 ? ` (${resolution.skipped.join(", ")} unavailable, fell back)` : ""
  const params: RouteParams | undefined = target.params
  return finish({
    action: "route",
    category,
    model,
    params,
    reason: (veto ? veto.reason : `routed to "${category}" (confidence ${confidence.toFixed(2)})`) + fallbackNote,
    confidence,
    scores: scoring.scores,
    vetoedBy,
    classifierUsed,
    classification,
    signals: signalsSummary,
    latencyMs: Date.now() - started,
  })
}
