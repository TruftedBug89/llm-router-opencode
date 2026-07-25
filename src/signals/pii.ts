/**
 * Signal: PII / secret detection.
 *
 * Regex-based detectors for personal data and credentials. When something
 * matches, the signal vetoes routing into the configured "private" category
 * so sensitive content can be sent to a local/self-hosted model instead of
 * a cloud provider.
 *
 * IMPORTANT: this signal never includes the matched values in logs or
 * metadata — only the detector names.
 */

import type { Signal } from "../types.ts"

interface Detector {
  name: string
  re: RegExp
  /** Optional extra validation to reduce false positives. */
  validate?: (match: string) => boolean
}

/** Luhn checksum for credit-card-like digit sequences. */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "")
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let double = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

export const DETECTORS: Detector[] = [
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  {
    name: "credit_card",
    re: /\b(?:\d[ -]*?){13,19}\b/,
    validate: (m) => luhnValid(m),
  },
  {
    name: "iban",
    re: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/,
    validate: (m) => m.replace(/\s/g, "").length >= 15,
  },
  { name: "us_ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    name: "phone",
    re: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]\d{3,4}[ -]?\d{0,4}\b/,
    validate: (m) => m.replace(/\D/g, "").length >= 9,
  },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
  { name: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  {
    name: "password_assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  { name: "passport_like", re: /\b[A-Z]{1,2}\d{6,9}\b/ },
]

export const piiSignal: Signal = (ctx) => {
  const pii = ctx.config.signals.pii
  if (!pii.enabled || pii.action === "off") return null

  const allow = pii.types ? new Set(pii.types) : null
  const found: string[] = []

  for (const det of DETECTORS) {
    if (allow && !allow.has(det.name)) continue
    const m = det.re.exec(ctx.text)
    if (!m) continue
    if (det.validate && !det.validate(m[0])) continue
    found.push(det.name)
  }

  if (found.length === 0) return null

  // Never log the actual values — only which detector fired.
  return {
    veto: {
      category: pii.route,
      reason: `PII detected (${found.join(", ")}) — routing to a private model`,
    },
    reason: `PII: ${found.join(", ")}`,
    metadata: { detectors: found },
  }
}
