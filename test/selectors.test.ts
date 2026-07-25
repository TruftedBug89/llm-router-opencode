import { test } from "node:test"
import assert from "node:assert/strict"
import { decide, selectModel } from "../src/router.ts"
import type { CatalogEntry, ModelCapabilities } from "../src/types.ts"
import { makeConfig, makeCtx, outcome } from "./helpers.ts"

function entry(providerID: string, modelID: string, caps: ModelCapabilities = {}): CatalogEntry {
  return { providerID, modelID, caps: { status: "active", exists: true, ...caps } }
}

const CATALOG: CatalogEntry[] = [
  entry("opencode", "big-pickle", { free: true, contextLimit: 128_000, name: "Big Pickle" }),
  entry("opencode", "mimo-v2.5-free", { free: true, contextLimit: 1_000_000, imageInput: true, name: "MiMo V2.5 Free" }),
  entry("opencode", "kimi-k2.7-code", { free: false, contextLimit: 262_144, name: "Kimi K2.7 Code" }),
  entry("opencode-go", "kimi-k3", { free: false, contextLimit: 262_144, imageInput: true, name: "Kimi K3" }),
  entry("opencode", "old-free-model", { free: true, status: "deprecated" }),
]

test("freeOnly + prefer picks the matching free model", () => {
  const res = selectModel({ freeOnly: true, prefer: ["nano", "pickle"] }, CATALOG)
  assert.deepEqual(res?.model, { providerID: "opencode", modelID: "big-pickle" })
})

test("prefer also matches display names", () => {
  const res = selectModel({ freeOnly: true, prefer: ["MiMo"] }, CATALOG)
  assert.deepEqual(res?.model, { providerID: "opencode", modelID: "mimo-v2.5-free" })
})

test("vision selector only picks image-capable models", () => {
  const res = selectModel({ vision: true, providers: ["opencode-go", "opencode"] }, CATALOG)
  assert.deepEqual(res?.model, { providerID: "opencode-go", modelID: "kimi-k3" }) // provider priority wins
})

test("pick largest chooses the biggest context window", () => {
  const res = selectModel({ pick: "largest" }, CATALOG)
  assert.deepEqual(res?.model, { providerID: "opencode", modelID: "mimo-v2.5-free" })
})

test("deprecated models are always excluded", () => {
  const res = selectModel({ freeOnly: true, prefer: ["old-free"] }, CATALOG)
  // "old-free-model" matches the regex but is deprecated; falls back to first free candidate
  assert.ok(res)
  assert.notEqual(res.model.modelID, "old-free-model")
})

test("empty selector result returns null", () => {
  assert.equal(selectModel({ vision: true, freeOnly: true, providers: ["anthropic"] }, CATALOG), null)
  assert.equal(selectModel({ minContext: 999_999_999 }, CATALOG), null)
})

test("prefer falls through to the first regex with matches", () => {
  const res = selectModel({ prefer: ["nonexistent", "kimi"] }, CATALOG)
  assert.deepEqual(res?.model, { providerID: "opencode", modelID: "kimi-k2.7-code" }) // catalog order within matches
})

test("decide() routes through a dynamic selector", async () => {
  const config = makeConfig()
  config.routes = { code: { model: { auto: { providers: ["opencode-go", "opencode"], prefer: ["kimi"] } } } }
  const ctx = makeCtx(config)
  const decision = await decide({
    ctx,
    outcomes: [outcome("task-type", 1, { votes: { code: 1 } })],
    catalog: () => CATALOG,
  })
  assert.equal(decision.action, "route")
  assert.deepEqual(decision.model, { providerID: "opencode-go", modelID: "kimi-k3" })
})

test("decide() keeps the model when a selector matches nothing", async () => {
  const config = makeConfig()
  config.routes = { code: { model: { auto: { providers: ["does-not-exist"] } } } }
  const ctx = makeCtx(config)
  const decision = await decide({
    ctx,
    outcomes: [outcome("task-type", 1, { votes: { code: 1 } })],
    catalog: () => CATALOG,
  })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /no available model/)
})
