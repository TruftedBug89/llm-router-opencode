import { test } from "node:test"
import assert from "node:assert/strict"
import { rulesSignal } from "../src/signals/rules.ts"
import { makeConfig, makeCtx } from "./helpers.ts"
import type { CustomRule, SignalResult } from "../src/types.ts"

function run(text: string, list: CustomRule[]): SignalResult | null {
  const config = makeConfig({ signals: { rules: { list } } })
  return (rulesSignal(makeCtx(config, { text })) as SignalResult | null) ?? null
}

test("veto rule short-circuits with a veto", () => {
  const result = run("deploy this to production now", [
    { match: "production", route: "reasoning", veto: true, name: "prod-guard" },
  ])
  assert.ok(result?.veto)
  assert.equal(result.veto.category, "reasoning")
  assert.match(result.veto.reason, /prod-guard/)
})

test("non-veto rules cast weighted votes", () => {
  const result = run("please review my kubernetes yaml", [
    { match: "kubernetes|k8s", route: "code", name: "k8s" },
  ])
  assert.equal(result?.veto, undefined)
  assert.equal(result?.votes?.["code"], 1)
})

test("multiple matching rules merge votes, strongest wins", () => {
  const result = run("rust and kubernetes", [
    { match: "rust", route: "code", weight: 1.5 },
    { match: "kubernetes", route: "agentic", weight: 3 },
  ])
  assert.equal(result?.votes?.["agentic"], 1)
  assert.equal(result?.votes?.["code"], 0.5)
})

test("invalid regexes are skipped", () => {
  const result = run("anything", [{ match: "([", route: "code" }])
  assert.equal(result, null)
})

test("custom regex flags are honored", () => {
  const result = run("DEPLOY", [{ match: "^deploy$", flags: "", route: "agentic" }])
  assert.equal(result, null) // case-sensitive: no match
  const result2 = run("DEPLOY", [{ match: "^deploy$", route: "agentic" }])
  assert.equal(result2?.votes?.["agentic"], 1) // default "i"
})

test("empty rule list returns null", () => {
  assert.equal(run("hello", []), null)
})
