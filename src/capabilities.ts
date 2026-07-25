/**
 * Live model capability catalog.
 *
 * Queries the running opencode server for its provider/model catalog and
 * normalizes per-model metadata: context window, image input, cost (free
 * tier detection), lifecycle status and display name.
 *
 * opencode model lists rotate frequently (zen free models come and go), so
 * the catalog REFRESHES ITSELF lazily in the background whenever it is
 * older than `ttlMs` — routing decisions always see a fresh model list
 * without ever blocking on a refetch.
 *
 * The catalog call is best-effort: any failure yields an empty catalog and
 * capability checks become no-ops.
 */

import type { CapabilitiesLookup, CatalogEntry, CatalogLister, ModelCapabilities, ModelRef } from "./types.ts"

export interface Capabilities {
  lookup: CapabilitiesLookup
  list: CatalogLister
  /** Number of models discovered (0 = catalog unavailable). */
  readonly size: number
  /** Force a reload. */
  refresh(): Promise<void>
}

const DEFAULT_TTL_MS = 60_000

interface RawModel {
  id?: string
  name?: string
  status?: string
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number }
  capabilities?: { input?: { image?: boolean } }
  // fallback shapes seen in the wild
  context_length?: number
  contextWindow?: number
  modalities?: { input?: string[] }
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
  const contextLimit = raw.limit?.context ?? raw.context_length ?? raw.contextWindow ?? undefined

  const modalityInputs = raw.modalities?.input ?? raw.architecture?.input_modalities
  const imageInput =
    raw.capabilities?.input?.image ??
    (Array.isArray(modalityInputs) && modalityInputs.includes("image") ? true : undefined) ??
    raw.vision ??
    undefined

  const inputCost = raw.cost?.input
  const outputCost = raw.cost?.output
  const free =
    typeof inputCost === "number" && typeof outputCost === "number"
      ? inputCost === 0 && outputCost === 0
      : undefined

  return {
    contextLimit: typeof contextLimit === "number" ? contextLimit : undefined,
    imageInput: imageInput === true ? true : imageInput === false ? false : undefined,
    free,
    status: typeof raw.status === "string" ? raw.status : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
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

/** Parse a provider-list payload into a catalog map. Exported for tests. */
export function normalizeCatalog(payload: unknown): Map<string, ModelCapabilities> {
  const map = new Map<string, ModelCapabilities>()
  for (const provider of extractProviders(payload)) {
    const providerID = provider.id
    if (!providerID || !provider.models) continue
    const models = Array.isArray(provider.models)
      ? provider.models.map((m, i) => [String(m.id ?? i), m] as const)
      : Object.entries(provider.models)
    for (const [modelID, raw] of models) {
      map.set(`${providerID}/${modelID}`, normalizeModel(raw))
    }
  }
  return map
}

export async function createCapabilities(client: unknown, ttlMs: number = DEFAULT_TTL_MS): Promise<Capabilities> {
  let map = new Map<string, ModelCapabilities>()
  let loadedAt = 0
  let refreshing = false

  const doRefresh = async (): Promise<void> => {
    if (refreshing) return
    refreshing = true
    try {
      const providerApi = asRecord(client)?.["provider"] as
        | { list?: (args?: unknown) => Promise<unknown> }
        | undefined
      if (providerApi?.list) {
        const result = await providerApi.list()
        const fresh = normalizeCatalog(result)
        if (fresh.size > 0) {
          map = fresh
          loadedAt = Date.now()
        }
      }
    } catch {
      // catalog unavailable — capability checks become no-ops
    } finally {
      refreshing = false
    }
  }

  await doRefresh()

  const maybeRefresh = (): void => {
    if (map.size > 0 && Date.now() - loadedAt > ttlMs) void doRefresh()
  }

  const lookup: CapabilitiesLookup = (ref: ModelRef) => {
    maybeRefresh()
    if (map.size === 0) return undefined
    const hit = map.get(`${ref.providerID}/${ref.modelID}`)
    return hit ?? { exists: false }
  }

  const list: CatalogLister = () => {
    maybeRefresh()
    return [...map.entries()].map(([key, caps]) => {
      const slash = key.indexOf("/")
      return { providerID: key.slice(0, slash), modelID: key.slice(slash + 1), caps }
    })
  }

  return {
    lookup,
    list,
    get size() {
      return map.size
    },
    refresh: doRefresh,
  }
}
