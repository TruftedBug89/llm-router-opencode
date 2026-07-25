import { test } from "node:test"
import assert from "node:assert/strict"
import { decide, parseModelRef } from "../src/router.ts"
import type { ClassifierCall } from "../src/classifier.ts"
import type { Classification, RouterConfig, SignalContext } from "../src/types.ts"
import { makeConfig, makeCtx, outcome } from "./helpers.ts"

const ROUTES = {
  routes: {
    trivial: "openai/gpt-4.1-nano",
    simple: "openai/gpt-4.1-mini",
    code: "anthropic/claude-sonnet-4-5",
    reasoning: { model: "openai/o3", params: { temperature: 0.1 } },
    creative: "anthropic/claude-opus-4-5",
    vision: "openai/gpt-4.1",
    agentic: "anthropic/claude-sonnet-4-5",
    long_context: "google/gemini-2.5-pro",
    private: "ollama/qwen3:8b",
  },
}

function setup(configOverrides: Record<string, unknown> = {}): { config: RouterConfig; ctx: SignalContext } {
  const config = makeConfig({ ...ROUTES, ...configOverrides })
  return { config, ctx: makeCtx(config) }
}

function classifierReturning(classification: Classification | null) {
  return async (): Promise<ClassifierCall> =>
    classification
      ? { ok: true, classification, cached: false, latencyMs: 5 }
      : { ok: false, cached: false, latencyMs: 5, error: "boom" }
}

test("parseModelRef splits on the first slash only", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet-4-5"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  })
  assert.deepEqual(parseModelRef("openrouter/google/gemini-2.5-flash"), {
    providerID: "openrouter",
    modelID: "google/gemini-2.5-flash",
  })
  assert.equal(parseModelRef("noslash"), null)
  assert.equal(parseModelRef("/nonempty"), null)
})

test("clear winner routes with params", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [
      outcome("complexity", 1, { votes: { reasoning: 0.9 } }),
      outcome("task-type", 1, { votes: { reasoning: 0.7 } }),
    ],
    classifyFn: classifierReturning(null),
  })
  assert.equal(decision.action, "route")
  assert.equal(decision.category, "reasoning")
  assert.deepEqual(decision.model, { providerID: "openai", modelID: "o3" })
  assert.deepEqual(decision.params, { temperature: 0.1 })
  assert.equal(decision.classifierUsed, false) // margin was clear; classifier skipped
})

test("uncertain prompts call the small AI and it swings the vote", async () => {
  const { ctx } = setup()
  ctx.currentModel = { providerID: "openai", modelID: "gpt-4.1-mini" } // avoid the same-model no-op
  const tie = [
    outcome("complexity", 1, { votes: { code: 0.5 } }),
    outcome("task-type", 1, { votes: { creative: 0.5, reasoning: 0.5 } }),
  ]
  const decision = await decide({
    ctx,
    outcomes: tie,
    classifyFn: classifierReturning({ taskType: "code", complexity: 6, needsTools: false, containsPii: false }),
  })
  assert.equal(decision.classifierUsed, true)
  assert.equal(decision.action, "route")
  assert.equal(decision.category, "code")
  assert.deepEqual(decision.model, { providerID: "anthropic", modelID: "claude-sonnet-4-5" })
})

test("unavailable classifier + low confidence keeps the current model", async () => {
  const { ctx } = setup()
  const tie = [
    outcome("a", 1, { votes: { code: 0.5 } }),
    outcome("b", 1, { votes: { creative: 0.5, reasoning: 0.5 } }),
  ]
  const decision = await decide({ ctx, outcomes: tie, classifyFn: classifierReturning(null) })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /low confidence/)
})

test("PII veto beats every other signal", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [
      outcome("task-type", 1, { votes: { code: 1 } }),
      outcome("pii", 1, { veto: { category: "private", reason: "PII detected (email)" }, reason: "PII: email" }),
    ],
    classifyFn: classifierReturning(null),
  })
  assert.equal(decision.action, "route")
  assert.equal(decision.category, "private")
  assert.equal(decision.vetoedBy, "pii")
  assert.deepEqual(decision.model, { providerID: "ollama", modelID: "qwen3:8b" })
  assert.equal(decision.classifierUsed, false) // vetoes skip the classifier
})

test("PII veto without a configured private route degrades to normal voting", async () => {
  const { ctx } = setup({ routes: { private: undefined } })
  delete ctx.config.routes["private"]
  const decision = await decide({
    ctx,
    outcomes: [
      outcome("task-type", 1, { votes: { code: 1 } }),
      outcome("pii", 1, { veto: { category: "private", reason: "PII" } }),
    ],
  })
  assert.equal(decision.category, "code")
  assert.equal(decision.vetoedBy, undefined)
})

test("vision veto is dropped when the current model already sees images", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [outcome("tools-needed", 1, { veto: { category: "vision", reason: "1 image(s) attached" } })],
    capabilities: () => ({ imageInput: true, exists: true }),
  })
  assert.equal(decision.action, "keep")
})

test("vision veto stands when the current model cannot see images", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [outcome("tools-needed", 1, { veto: { category: "vision", reason: "1 image(s) attached" } })],
    capabilities: () => ({ imageInput: false, exists: true }),
  })
  assert.equal(decision.action, "route")
  assert.equal(decision.category, "vision")
})

test("long_context is dropped when the current model already fits", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [
      outcome("context-length", 1, {
        votes: { long_context: 1 },
        metadata: { approxTokens: 8000 },
        reason: "~8,000 tokens",
      }),
    ],
    capabilities: () => ({ contextLimit: 128_000, exists: true }),
  })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /already fits/)
})

test("routing to the model already in use is a no-op", async () => {
  const { ctx } = setup() // current model is anthropic/claude-sonnet-4-5, code route targets it
  const decision = await decide({
    ctx,
    outcomes: [outcome("task-type", 1, { votes: { code: 1 } })],
  })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /already on the target model/)
})

test("unavailable route target keeps the current model", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [outcome("task-type", 1, { votes: { reasoning: 1 } })],
    capabilities: (ref) => (ref.modelID === "o3" ? { exists: false } : { exists: true }),
  })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /not available/)
})

test("category without a configured route keeps the current model", async () => {
  const config = makeConfig({ routes: { code: "anthropic/claude-sonnet-4-5" } })
  const ctx = makeCtx(config)
  const decision = await decide({
    ctx,
    outcomes: [outcome("task-type", 1, { votes: { creative: 1 } })],
  })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /no route configured/)
})

test('"keep" route never changes the model', async () => {
  const config = makeConfig({ routes: { trivial: "keep" } })
  const ctx = makeCtx(config)
  const decision = await decide({ ctx, outcomes: [outcome("complexity", 1, { votes: { trivial: 1 } })] })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /"keep"/)
})

test("custom rule veto has top priority over PII", async () => {
  const { ctx } = setup()
  const decision = await decide({
    ctx,
    outcomes: [
      outcome("pii", 1, { veto: { category: "private", reason: "PII" } }),
      outcome("rules", 3, { veto: { category: "reasoning", reason: 'custom rule "prod" matched' } }),
    ],
  })
  assert.equal(decision.category, "reasoning")
  assert.equal(decision.vetoedBy, "rules")
})

test("no votes at all keeps the model", async () => {
  const { ctx } = setup()
  const decision = await decide({ ctx, outcomes: [], classifyFn: classifierReturning(null) })
  assert.equal(decision.action, "keep")
  assert.match(decision.reason, /no signal/)
})
