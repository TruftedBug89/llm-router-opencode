import { test } from "node:test"
import assert from "node:assert/strict"
import { stripJsonc, deepMerge, interpolateEnv, DEFAULT_CONFIG } from "../src/config.ts"

test("stripJsonc removes comments and trailing commas", () => {
  const jsonc = `{
    // line comment
    "a": 1, /* block comment */
    "url": "https://example.com/path", // keep // inside strings
    "list": [1, 2,],
  }`
  const parsed = JSON.parse(stripJsonc(jsonc)) as Record<string, unknown>
  assert.equal(parsed["a"], 1)
  assert.equal(parsed["url"], "https://example.com/path")
  assert.deepEqual(parsed["list"], [1, 2])
})

test("deepMerge merges objects and replaces arrays", () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }
  const merged = deepMerge(base, { nested: { y: 3 }, list: [9], b: 2 }) as typeof base & { b: number }
  assert.equal(merged.a, 1)
  assert.deepEqual(merged.nested, { x: 1, y: 3 })
  assert.deepEqual(merged.list, [9])
  assert.equal(merged.b, 2)
})

test("interpolateEnv resolves {env:VAR} values only", () => {
  process.env["LLM_ROUTER_TEST_KEY"] = "secret-value"
  const resolved = interpolateEnv({
    key: "{env:LLM_ROUTER_TEST_KEY}",
    literal: "prefix {env:LLM_ROUTER_TEST_KEY} suffix",
    missing: "{env:LLM_ROUTER_DEFINITELY_MISSING}",
    nested: { arr: ["{env:LLM_ROUTER_TEST_KEY}"] },
  })
  assert.equal(resolved.key, "secret-value")
  assert.equal(resolved.literal, "prefix {env:LLM_ROUTER_TEST_KEY} suffix")
  assert.equal(resolved.missing, "")
  assert.deepEqual(resolved.nested, { arr: ["secret-value"] })
})

test("defaults are sane", () => {
  assert.equal(DEFAULT_CONFIG.mode, "auto")
  assert.equal(DEFAULT_CONFIG.classifier.when, "uncertain")
  assert.equal(DEFAULT_CONFIG.signals.pii.route, "private")
  assert.equal(DEFAULT_CONFIG.signals.bert.enabled, false)
})
