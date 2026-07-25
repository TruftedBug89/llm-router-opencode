import { test } from "node:test"
import assert from "node:assert/strict"
import { extractJson, normalizeClassification } from "../src/classifier.ts"

test("extractJson parses a bare JSON object", () => {
  assert.deepEqual(extractJson('{"task_type":"code","complexity":5}'), { task_type: "code", complexity: 5 })
})

test("extractJson parses fenced JSON", () => {
  const text = 'Sure! Here you go:\n```json\n{"task_type":"math","complexity":8}\n```'
  assert.deepEqual(extractJson(text), { task_type: "math", complexity: 8 })
})

test("extractJson finds JSON inside prose", () => {
  const text = 'The classification is {"task_type":"chat","complexity":1} as requested.'
  assert.deepEqual(extractJson(text), { task_type: "chat", complexity: 1 })
})

test("extractJson returns null when there is no JSON", () => {
  assert.equal(extractJson("no json here"), null)
  assert.equal(extractJson("{ broken"), null)
})

test("normalizeClassification clamps and validates", () => {
  const c = normalizeClassification({ task_type: "CODE", complexity: 42, needs_tools: true, contains_pii: false, reason: "x" })
  assert.ok(c)
  assert.equal(c.taskType, "code")
  assert.equal(c.complexity, 10)
  assert.equal(c.needsTools, true)

  const unknown = normalizeClassification({ task_type: "weird", complexity: "not-a-number" })
  assert.ok(unknown)
  assert.equal(unknown.taskType, "other")
  assert.equal(unknown.complexity, 5)
})
