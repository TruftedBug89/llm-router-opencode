import { test } from "node:test"
import assert from "node:assert/strict"
import { taskTypeSignal } from "../src/signals/task-type.ts"
import { makeConfig, makeCtx } from "./helpers.ts"

function voteFor(text: string): Record<string, number> {
  const result = taskTypeSignal(makeCtx(makeConfig(), { text }))
  return (result as { votes?: Record<string, number> } | null)?.votes ?? {}
}

test("code fences and stack traces vote code", () => {
  const votes = voteFor("```ts\nconst x: number = 'a'\n```\nTypeError: cannot read properties of undefined — fix src/index.ts please")
  assert.ok((votes["code"] ?? 0) > 0.5, JSON.stringify(votes))
})

test("math content votes reasoning", () => {
  const votes = voteFor("Calculate the integral of x^2 and prove the theorem step by step")
  assert.ok((votes["reasoning"] ?? 0) > 0.5, JSON.stringify(votes))
})

test("creative writing requests vote creative", () => {
  const votes = voteFor("Escribe un poema sobre el mar y luego una historia corta de ficción")
  assert.ok((votes["creative"] ?? 0) > 0.6, JSON.stringify(votes))
})

test("build/implement requests vote agentic", () => {
  const votes = voteFor("Implement a REST API endpoint, add tests, then run the suite and fix the config file")
  assert.ok((votes["agentic"] ?? 0) > 0.5, JSON.stringify(votes))
})

test("plain chat yields nothing", () => {
  assert.equal(taskTypeSignal(makeCtx(makeConfig(), { text: "good morning, how are you?" })), null)
})
