import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyViaOpencode, isClassifierSession, type OpencodeClientLike } from "../src/opencode-backend.ts"
import { __clearClassifierCache } from "../src/classifier.ts"
import { makeConfig } from "./helpers.ts"

interface PromptRequest {
  path: { id: string }
  body: {
    agent: string
    model: { providerID: string; modelID: string }
    system: string
    tools: Record<string, boolean>
    parts: Array<{ type: string; text: string }>
  }
}

function mockClient(handlers: {
  onPrompt?: (req: PromptRequest) => unknown
  createResult?: unknown
}): { client: OpencodeClientLike; calls: string[] } {
  const calls: string[] = []
  const client: OpencodeClientLike = {
    session: {
      create: async () => {
        calls.push("create")
        return handlers.createResult ?? { data: { id: "ses_cls" } }
      },
      prompt: async (req: unknown) => {
        calls.push("prompt")
        return handlers.onPrompt?.(req as PromptRequest) ?? { data: { info: {}, parts: [] } }
      },
      abort: async () => {
        calls.push("abort")
      },
      delete: async () => {
        calls.push("delete")
      },
    },
  }
  return { client, calls }
}

const MODEL = { providerID: "opencode", modelID: "big-pickle" }
const AGENT = "llm-router-classifier"

test("classifies through an opencode session and cleans up", async () => {
  __clearClassifierCache()
  let trackedDuringPrompt = false
  const { client, calls } = mockClient({
    onPrompt: (req) => {
      assert.equal(req.path.id, "ses_cls")
      assert.equal(req.body.agent, AGENT)
      assert.equal(req.body.model.providerID, "opencode")
      assert.equal(req.body.tools["bash"], false)
      assert.equal(req.body.tools["edit"], false)
      assert.match(req.body.system, /classifier/)
      trackedDuringPrompt = isClassifierSession("ses_cls")
      return {
        data: {
          info: {},
          parts: [{ type: "text", text: '{"task_type":"code","complexity":7,"needs_tools":true,"contains_pii":false,"reason":"debug request"}' }],
        },
      }
    },
  })

  const res = await classifyViaOpencode(client, "why does my build fail with ERESOLVE?", makeConfig().classifier, MODEL, AGENT)

  assert.equal(res.ok, true)
  assert.equal(res.classification?.taskType, "code")
  assert.equal(res.classification?.needsTools, true)
  assert.equal(trackedDuringPrompt, true, "session must be tracked while the prompt runs")
  assert.equal(isClassifierSession("ses_cls"), false, "session untracked after the call")
  assert.deepEqual(calls.slice(0, 2), ["create", "prompt"])

  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(calls.includes("delete"), "classifier session is deleted afterwards")
})

test("second identical call is served from cache without new sessions", async () => {
  __clearClassifierCache()
  const { client, calls } = mockClient({
    onPrompt: () => ({
      data: { parts: [{ type: "text", text: '{"task_type":"chat","complexity":1}' }] },
    }),
  })
  const cfg = makeConfig().classifier
  const first = await classifyViaOpencode(client, "cache me please", cfg, MODEL, AGENT)
  const second = await classifyViaOpencode(client, "cache me please", cfg, MODEL, AGENT)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(calls.filter((c) => c === "create").length, 1)
})

test("session creation failure degrades gracefully", async () => {
  __clearClassifierCache()
  const { client } = mockClient({ createResult: { data: undefined, error: { data: { message: "server exploded" } } } })
  const res = await classifyViaOpencode(client, "anything", makeConfig().classifier, MODEL, AGENT)
  assert.equal(res.ok, false)
  assert.match(res.error ?? "", /server exploded/)
})

test("non-JSON replies degrade gracefully", async () => {
  __clearClassifierCache()
  const { client } = mockClient({ onPrompt: () => ({ data: { parts: [{ type: "text", text: "I cannot help with that." }] } }) })
  const res = await classifyViaOpencode(client, "unique text for json failure", makeConfig().classifier, MODEL, AGENT)
  assert.equal(res.ok, false)
  assert.match(res.error ?? "", /no JSON/)
})
