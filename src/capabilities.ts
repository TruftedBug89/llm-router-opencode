/**
 * Model capability lookup.
 *
 * Queries the running opencode server for its provider/model catalog and
 * normalizes context-window sizes and image-input support. Used for
 * capability-aware routing decisions (e.g. don't reroute to a vision model
 * when the current one already sees images; don't reroute to a long-context
 * model when the current one already fits).
 *
 * The catalog call is best-effort: any failure yields an empty lookup and
 * the router simply skips capability checks.
 */

import type { CapabilitiesLookup, ModelCapabilities, ModelRef } from "./types.ts"

export interface Capabilities {
  lookup: CapabilitiesLookup
  /** Number of models discovered (0 = catalog unavailable). */
  size: number
}

interface RawModel {
  limit?: { context?: number; output?: number }
  context_length?: number
  contextWindow?: number
  modalities?: { input?: string[] }
  capabilities?: { vision?: boolean }
  vision?: boolean
  architecture?: { input_modalities?: string[] }
}

interface RawProvider {
  id?: string
  models?: Record<string, RawModel> | RawModel[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeModel(raw: RawModel): ModelCapabilities {
  const contextLimit =
    raw.limit?.context ?? raw.context_length ?? raw.contextWindow ?? undefined
  const inputs = raw.modalities?.input ?? raw.architecture?.input_modalities
  const imageInput =
    (Array.isArray(inputs) && inputs.includes("image")) ||
    raw.capabilities?.vision === true ||
    raw.vision === true ||
    undefined
  return {
    contextLimit: typeof contextLimit === "number" ? contextLimit : undefined,
    imageInput,
    exists: true,
  }
}

function extractProviders(payload: unknown): RawProvider[] {
  // hey-api SDKs resolve to { data, error }; plain fetches resolve to the body.
  const root = asRecord(payload)
  const data = root && "data" in root ? root["data"] : payload
  const obj = asRecord(data)
  if (!obj) return []
  const all = obj["all"]
  if (Array.isArray(all)) return all as RawProvider[]
  return []
}

function collect(payload: unknown, map: Map<string, ModelCapabilities>): void {
  for (const provider of extractProviders(payload)) {
    const providerID = provider.id
    if (!providerID || !provider.models) continue
    const models = Array.isArray(provider.models)
      ? provider.models.map((m, i) => [String((m as { id?: string }).id ?? i), m] as const)
      : Object.entries(provider.models)
    for (const [modelID, raw] of models) {
      map.set(`${providerID}/${modelID}`, normalizeModel(raw))
    }
  }
}

/**
 * Build the lookup. `client` is the opencode SDK client; kept as `unknown`
 * here so a catalog-shape change can never break the plugin at runtime.
 */
export async function createCapabilities(client: unknown): Promise<Capabilities> {
  const map = new Map<string, ModelCapabilities>()
  try {
    const providerApi = asRecord(client)?.["provider"] as
      | { list?: (args?: unknown) => Promise<unknown> }
      | undefined
    if (providerApi?.list) {
      const result = await providerApi.list()
      collect(result, map)
    }
  } catch {
    // catalog unavailable — capability checks become no-ops
  }

  const lookup: CapabilitiesLookup = (ref: ModelRef) => {
    if (map.size === 0) return undefined
    const hit = map.get(`${ref.providerID}/${ref.modelID}`)
    return hit ?? { exists: false }
  }
  return { lookup, size: map.size }
}
