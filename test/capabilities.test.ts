import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeCatalog } from "../src/capabilities.ts"

const PAYLOAD = {
  all: [
    {
      id: "opencode",
      models: {
        "big-pickle": {
          name: "Big Pickle",
          status: "active",
          cost: { input: 0, output: 0 },
          limit: { context: 128_000, output: 32_000 },
          capabilities: { input: { image: false } },
        },
        "mimo-v2.5-free": {
          name: "MiMo V2.5 Free",
          status: "beta",
          cost: { input: 0, output: 0 },
          limit: { context: 1_000_000, output: 128_000 },
          capabilities: { input: { image: true } },
        },
      },
    },
    {
      id: "opencode-go",
      models: {
        "kimi-k3": {
          name: "Kimi K3",
          status: "active",
          cost: { input: 0.95, output: 4 },
          limit: { context: 262_144, output: 65_536 },
          capabilities: { input: { image: true } },
        },
      },
    },
  ],
}

test("normalizeCatalog extracts cost, vision, context and status", () => {
  const map = normalizeCatalog(PAYLOAD)
  assert.equal(map.size, 3)

  const pickle = map.get("opencode/big-pickle")!
  assert.equal(pickle.free, true)
  assert.equal(pickle.imageInput, false)
  assert.equal(pickle.contextLimit, 128_000)
  assert.equal(pickle.status, "active")
  assert.equal(pickle.name, "Big Pickle")
  assert.equal(pickle.exists, true)

  const mimo = map.get("opencode/mimo-v2.5-free")!
  assert.equal(mimo.free, true)
  assert.equal(mimo.imageInput, true)
  assert.equal(mimo.contextLimit, 1_000_000)
  assert.equal(mimo.status, "beta")

  const kimi = map.get("opencode-go/kimi-k3")!
  assert.equal(kimi.free, false)
  assert.equal(kimi.imageInput, true)
})

test("normalizeCatalog unwraps hey-api { data } envelopes", () => {
  const map = normalizeCatalog({ data: PAYLOAD })
  assert.equal(map.size, 3)
})

test("normalizeCatalog tolerates garbage", () => {
  assert.equal(normalizeCatalog(null).size, 0)
  assert.equal(normalizeCatalog("nope").size, 0)
  assert.equal(normalizeCatalog({ all: "nope" }).size, 0)
})
