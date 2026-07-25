import { test } from "node:test"
import assert from "node:assert/strict"
import { piiSignal, luhnValid } from "../src/signals/pii.ts"
import { makeConfig, makeCtx } from "./helpers.ts"
import type { SignalResult } from "../src/types.ts"

function run(text: string, configOverrides: Record<string, unknown> = {}): SignalResult | null {
  const result = piiSignal(makeCtx(makeConfig(configOverrides), { text }))
  return (result as SignalResult | null) ?? null
}

test("luhn checksum works", () => {
  assert.equal(luhnValid("4242424242424242"), true)
  assert.equal(luhnValid("4242 4242 4242 4242"), true)
  assert.equal(luhnValid("4242424242424241"), false)
  assert.equal(luhnValid("123"), false)
})

test("detects email addresses and vetoes to private", () => {
  const result = run("please email the report to jane.doe@company.com when done")
  assert.ok(result?.veto)
  assert.equal(result.veto.category, "private")
  assert.match(result.veto.reason, /email/)
})

test("detects Luhn-valid credit cards, rejects invalid digit strings", () => {
  const hit = run("my card is 4242 4242 4242 4242, why was it declined?")
  assert.ok(hit?.veto)
  assert.match(hit.veto.reason, /credit_card/)

  const miss = run("reference number 4242424242424241 is on the invoice")
  assert.equal(miss, null)
})

test("detects cloud credentials", () => {
  const aws = run("use AKIAIOSFODNN7EXAMPLE for the bucket")
  assert.match(aws?.veto?.reason ?? "", /aws_access_key/)

  const openai = run("set the key to sk-abcdefghijklmnopqrstuvwxyz123456")
  assert.match(openai?.veto?.reason ?? "", /openai_key/)

  const gh = run("token: ghp_abcdefghijklmnopqrstuvwxyz1234")
  assert.match(gh?.veto?.reason ?? "", /github_token/)
})

test("detects private key blocks and JWTs", () => {
  assert.ok(run("-----BEGIN RSA PRIVATE KEY-----\nstuff")?.veto)
  assert.ok(run("use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepart")?.veto)
})

test("clean prompts do not fire", () => {
  assert.equal(run("how do I center a div in css?"), null)
  assert.equal(run("what is the time complexity of quicksort?"), null)
})

test("types filter restricts detectors", () => {
  const result = run("use AKIAIOSFODNN7EXAMPLE for the bucket", {
    signals: { pii: { types: ["email"] } },
  })
  assert.equal(result, null)
})

test("action off disables detection", () => {
  const result = run("email me at jane.doe@company.com", { signals: { pii: { action: "off" } } })
  assert.equal(result, null)
})

test("metadata never contains the matched values", () => {
  const result = run("reach me at jane.doe@company.com")
  assert.ok(result)
  assert.ok(!JSON.stringify(result.metadata).includes("jane.doe@company.com"))
})
