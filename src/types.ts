/**
 * Shared types for opencode-llm-router.
 *
 * The core (signals + router) intentionally does NOT depend on the opencode
 * SDK: parts/messages use minimal structural types so the engine stays
 * portable and unit-testable with plain `node --test`.
 */

/** Built-in route categories. Users may define extra ones via custom rules/signals. */
export const BUILTIN_CATEGORIES = [
  "trivial",
  "simple",
  "code",
  "reasoning",
  "creative",
  "vision",
  "agentic",
  "long_context",
  "private",
] as const

export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number]

/** A category is any string; built-ins are just the documented defaults. */
export type Category = string

/** Minimal structural view of an opencode message part. */
export interface RouterPart {
  type: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  synthetic?: boolean
  name?: string
  [key: string]: unknown
}

export interface ModelRef {
  providerID: string
  modelID: string
}

/** Sampling parameters applied through the `chat.params` hook. */
export interface RouteParams {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options?: Record<string, unknown>
}

/**
 * Dynamic model selection against the LIVE opencode catalog. Model lists
 * rotate frequently (especially zen free models), so instead of hardcoding
 * IDs you describe what you want and the router picks it fresh.
 */
export interface ModelSelector {
  /**
   * Ordered case-insensitive regexes matched against "provider/modelID" and
   * the model's display name. The first regex with any match wins.
   */
  prefer?: string[]
  /** Only zero-cost models (zen free tier). */
  freeOnly?: boolean
  /** Restrict to these providers; earlier entries are preferred. */
  providers?: string[]
  /** Require image-input support. */
  vision?: boolean
  /** Minimum context window in tokens. */
  minContext?: number
  /** Among matches: "first" (catalog order), "largest" or "smallest" context window. Default "first". */
  pick?: "first" | "largest" | "smallest"
}

/**
 * What a route (or the classifier) can point at:
 *   - "provider/modelID"      exact model
 *   - ["a/x", "b/y"]          fallback chain, first available wins
 *   - { auto: ModelSelector } dynamic pick from the live catalog
 *   - "keep"                  leave the user's model untouched
 */
export type RouteModel = string | string[] | { auto: ModelSelector }

/** A route maps a category to a target model plus optional params. */
export interface RouteTarget {
  model: RouteModel
  params?: RouteParams
}

export type Route = string | string[] | RouteTarget

/** A user-defined routing rule evaluated against the raw prompt text. */
export interface CustomRule {
  /** Optional human-readable name (shows up in logs). */
  name?: string
  /** Regular expression source tested against the prompt text. */
  match: string
  /** Regex flags. Defaults to "i". */
  flags?: string
  /** Category to route to when the rule matches (must exist in `routes`). */
  route: Category
  /** Vote weight for soft matches. Default 3. */
  weight?: number
  /** When true, a match short-circuits every other signal. Default false. */
  veto?: boolean
}

export interface ClassifierConfig {
  enabled: boolean
  /**
   * "opencode": classify with a model from your own opencode catalog
   * (zen / go / free models — no extra API keys, fully managed).
   * "endpoint": call any OpenAI-compatible HTTP endpoint directly.
   * Default "opencode".
   */
  source: "opencode" | "endpoint"
  /**
   * Small/fast model used for classification. Same forms as routes:
   * exact "provider/modelID", fallback chain, or { auto: selector }.
   * Default: { auto } — the cheapest free model in your catalog.
   */
  model: RouteModel
  /** [source: endpoint] OpenAI-compatible base URL. */
  baseURL: string
  /** [source: endpoint] API key. Supports "{env:VAR_NAME}" interpolation. */
  apiKey?: string
  /** [source: endpoint] Convenience: name of the env var holding the API key. */
  apiKeyEnv?: string
  /** [source: endpoint] Extra HTTP headers. */
  headers?: Record<string, string>
  /** Abort the classifier call after this many ms. Default 6000. */
  timeoutMs: number
  /** Only the first N characters of the prompt are sent to the classifier. Default 4000. */
  maxChars: number
  /** Weight of the classifier's votes in the fusion. Default 2. */
  weight: number
  /**
   * "always": call the small AI on every message.
   * "uncertain": only call it when local heuristics disagree (zero added latency
   * on obvious messages). Default "uncertain".
   */
  when: "always" | "uncertain"
  /** Margin (best - second, normalized) below which heuristics are "uncertain". Default 0.15. */
  uncertainMargin: number
  /** Classifier result cache TTL in minutes. Default 60. */
  cacheTtlMinutes: number
  /** Override the classifier system prompt entirely. */
  systemPrompt?: string
}

export interface PiiConfig {
  enabled: boolean
  /** "route": veto into `route` category. "off": disable detection. */
  action: "route" | "off"
  /** Category used when PII is detected. Point it at a local/private model in `routes`. Default "private". */
  route: Category
  /** Restrict detection to these detector names (default: all). */
  types?: string[]
}

export interface BertConfig {
  enabled: boolean
  /** Hugging Face zero-shot classification model id. */
  model: string
  /** Candidate labels. */
  labels: string[]
  /** Maps a label to a route category. Unmapped labels are ignored. */
  labelMap: Record<string, Category>
  /** Vote weight. Default 1.5. */
  weight: number
  /** Only the first N characters are classified. Default 2000. */
  maxChars: number
}

export interface SignalToggles {
  complexity: { enabled: boolean; weight: number }
  taskType: { enabled: boolean; weight: number }
  contextLength: { enabled: boolean; weight: number; longChars: number }
  toolsNeeded: { enabled: boolean; weight: number }
  pii: PiiConfig
  rules: { enabled: boolean; weight: number; list: CustomRule[] }
  bert: BertConfig
  custom: { enabled: boolean; weight: number; paths: string[] }
}

export interface LogConfig {
  enabled: boolean
  /** Override the decisions log path (JSONL). */
  path?: string
  /** Rotate the log when it grows past this many bytes. Default 5 MiB. */
  maxBytes: number
}

export interface RouterConfig {
  /** "auto": reroute. "suggest": only notify what it would do. "off": disabled. */
  mode: "auto" | "suggest" | "off"
  /** category -> target model. Missing category or "keep" = leave model untouched. */
  routes: Record<Category, Route>
  /** Normalized winner share required to reroute. Below this we keep the user's model. Default 0.4. */
  minConfidence: number
  /**
   * When non-empty, ONLY these agents are routed. Default ["auto-router"]:
   * the bundled agent (Tab to switch) — build and plan stay untouched.
   * Set to [] to route every agent.
   */
  onlyAgents: string[]
  /** Agents that must never be rerouted. */
  skipAgents: string[]
  /** When the user explicitly picked a model variant, respect it and skip routing. Default true. */
  respectVariant: boolean
  /** Show a TUI toast whenever a message is rerouted (or would be, in suggest mode). Default true. */
  notify: boolean
  classifier: ClassifierConfig
  signals: SignalToggles
  log: LogConfig
  /** Extra console logging of routing decisions. Default false. */
  debug: boolean
}

/** Normalized classification returned by the small AI. */
export interface Classification {
  taskType: string
  /** 1 (trivial) .. 10 (expert, multi-step) */
  complexity: number
  needsTools: boolean
  containsPii: boolean
  reason?: string
}

/** Everything a signal needs to vote. */
export interface SignalContext {
  /** Extracted user text (non-synthetic text parts, possibly truncated). */
  text: string
  /** All resolved message parts. */
  parts: RouterPart[]
  /** Agent handling the message (e.g. "build", "plan"). */
  agent: string
  sessionID: string
  /** Model the message would use if we did nothing. */
  currentModel?: ModelRef
  /** Whether the user explicitly selected a model variant. */
  hasVariant: boolean
  config: RouterConfig
  /** Project directory (worktree root). */
  directory: string
}

export interface Veto {
  category: Category
  reason: string
}

/** What a signal contributes to the fusion. */
export interface SignalResult {
  /** category -> vote strength in [0, 1]. */
  votes?: Record<Category, number>
  /** Hard override; short-circuits voting. First veto wins. */
  veto?: Veto
  /** Short human explanation used in logs/toasts. */
  reason?: string
  metadata?: Record<string, unknown>
}

export type Signal = (ctx: SignalContext) => SignalResult | null | Promise<SignalResult | null>

export interface SignalOutcome {
  name: string
  weight: number
  result: SignalResult | null
  latencyMs: number
  error?: string
}

/** Final routing decision for one message. */
export interface Decision {
  action: "route" | "keep"
  category?: Category
  model?: ModelRef
  params?: RouteParams
  reason: string
  /** Winner's normalized share of all votes, 0..1. */
  confidence: number
  scores: Record<Category, number>
  vetoedBy?: string
  classifierUsed: boolean
  classification?: Classification
  signals: Array<{ name: string; reason?: string }>
  latencyMs: number
}

/** Optional model-capability lookup used for capability-aware adjustments. */
export interface ModelCapabilities {
  /** Approximate context window in tokens, if known. */
  contextLimit?: number
  /** Whether the model accepts image inputs, if known. */
  imageInput?: boolean
  /** Whether the model exists in the user's configured providers, if known. */
  exists?: boolean
  /** Zero input + output cost (e.g. zen free tier), if known. */
  free?: boolean
  /** Provider-reported lifecycle: "active" | "alpha" | "beta" | "deprecated". */
  status?: string
  /** Human display name (regex `prefer` patterns also match against it). */
  name?: string
}

export type CapabilitiesLookup = (ref: ModelRef) => ModelCapabilities | undefined

/** One entry of the live model catalog. */
export interface CatalogEntry {
  providerID: string
  modelID: string
  caps: ModelCapabilities
}

export type CatalogLister = () => CatalogEntry[]
