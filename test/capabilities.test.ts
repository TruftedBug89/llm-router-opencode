import { test } from "node:test"
import assert from "node:assert/strict"
import { createCapabilities, normalizeCatalog } from "../src/capabilities.ts"

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


const PAYLOAD_SINGLE = {
  all: [
    {
      id: "opencode",
      models: {
        "big-pickle": {
          name: "Big Pickle",
          status: "active",
          cost: { input: 0, output: 0 },
          limit: { context: 128_000, output: 32_000 },
        },
      },
    },
  ],
}

test("createCapabilities does not block on a slow initial catalog fetch", async () => {
  let resolveList: (value: unknown) => void = () => {}
  const gate = new Promise<unknown>((resolve) => {
    resolveList = resolve
  })
  const client = { provider: { list: async () => gate } }
  const caps = await createCapabilities(client)
  // init returns immediately even though the catalog fetch is still pending
  assert.equal(caps.size, 0)

  resolveList({ data: PAYLOAD_SINGLE })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(caps.size, 1)
  assert.equal(caps.lookup({ providerID: "opencode", modelID: "big-pickle" })?.free, true)
})

test("a stalled catalog fetch aborts after the timeout and degrades to empty", async () => {
  const client = {
    provider: {
      list: async (opts: { signal?: AbortSignal }): Promise<never> =>
        new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    },
  }
  const started = Date.now()
  const caps = await createCapabilities(client, 60_000, 50)
  assert.equal(caps.size, 0)
  // refresh() also resolves (aborted) instead of hanging
  await caps.refresh()
  assert.ok(Date.now() - started < 2_000)
  assert.equal(caps.size, 0)
})

test("lookup retries the catalog when the initial fetch failed", async () => {
  let calls = 0
  const client = {
    provider: {
      list: async (): Promise<unknown> => {
        calls++
        if (calls === 1) throw new Error("server not ready yet")
        return { data: PAYLOAD_SINGLE }
      },
    },
  }
  const caps = await createCapabilities(client, 100)
  assert.equal(caps.size, 0) // initial fetch failed
  assert.equal(calls, 1)

  // retries are throttled; after the window a lookup refreshes the catalog
  await new Promise((resolve) => setTimeout(resolve, 120))
  caps.lookup({ providerID: "opencode", modelID: "big-pickle" })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(caps.size, 1)
  assert.equal(calls, 2)
})
