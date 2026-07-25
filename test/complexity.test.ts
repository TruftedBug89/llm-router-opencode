import { test } from "node:test"
import assert from "node:assert/strict"
import { complexitySignal } from "../src/signals/complexity.ts"
import { makeConfig, makeCtx } from "./helpers.ts"

function voteFor(text: string): Record<string, number> {
  const result = complexitySignal(makeCtx(makeConfig(), { text }))
  return (result as { votes?: Record<string, number> } | null)?.votes ?? {}
}

test("greets route to trivial with full strength", () => {
  for (const greeting of ["hi", "Hola!", "thanks", "gracias", "ok", "hey!"]) {
    const votes = voteFor(greeting)
    assert.equal(votes["trivial"], 1, `"${greeting}" should be trivial`)
  }
})

test("short statements lean trivial", () => {
  const votes = voteFor("sounds good")
  assert.ok((votes["trivial"] ?? 0) >= 0.7)
})

test("single short question leans simple", () => {
  const votes = voteFor("What is the capital of France?")
  assert.ok((votes["simple"] ?? 0) >= 0.6)
})

test("multi-part analytical prompt leans reasoning", () => {
  const text = [
    "Can you analyze the trade-offs between microservices and a monolith for our team?",
    "1. compare deployment strategies",
    "2. review the risks of each approach",
    "3. then design a step by step migration plan and explain why it scales",
  ].join("\n")
  const votes = voteFor(text)
  assert.ok((votes["reasoning"] ?? 0) >= 0.6, `expected strong reasoning vote, got ${JSON.stringify(votes)}`)
})

test("spanish reasoning keywords are detected", () => {
  const votes = voteFor(
    "Analiza en profundidad por qué falla esta arquitectura, compara las alternativas y diseña una estrategia de migración paso a paso para optimizar el sistema.",
  )
  assert.ok((votes["reasoning"] ?? 0) >= 0.5)
})

test("empty text yields null", () => {
  assert.equal(complexitySignal(makeCtx(makeConfig(), { text: "   " })), null)
})
