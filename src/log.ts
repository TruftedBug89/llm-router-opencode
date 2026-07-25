/**
 * Decision logger.
 *
 * Appends one JSON line per routing decision to a state file so users can
 * audit (or replay) why a given message was routed where it was.
 *
 * Privacy guarantee: the log NEVER contains prompt text — only categories,
 * models, scores, detector names and timing.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Decision, LogConfig } from "./types.ts"

export function defaultStateDir(): string {
  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local")
    return join(base, "opencode", "llm-router")
  }
  const base = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
  return join(base, "opencode", "llm-router")
}

export interface DecisionLogEntry {
  ts: string
  sessionID: string
  agent: string
  action: "route" | "keep"
  mode: string
  category?: string
  from?: string
  to?: string
  confidence: number
  reason: string
  vetoedBy?: string
  classifierUsed: boolean
  classification?: Decision["classification"]
  scores: Record<string, number>
  signals: Array<{ name: string; reason?: string }>
  latencyMs: number
}

export class DecisionLogger {
  private readonly path: string | null
  private readonly maxBytes: number

  constructor(cfg: LogConfig) {
    this.path = cfg.enabled ? (cfg.path ?? join(defaultStateDir(), "decisions.jsonl")) : null
    this.maxBytes = cfg.maxBytes > 0 ? cfg.maxBytes : 5 * 1024 * 1024
    if (this.path) {
      try {
        mkdirSync(join(this.path, ".."), { recursive: true })
      } catch {
        // best effort; write() will silently no-op if the dir is missing
      }
    }
  }

  write(entry: DecisionLogEntry): void {
    if (!this.path) return
    try {
      this.rotateIfNeeded()
      appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8")
    } catch {
      // logging must never break routing
    }
  }

  private rotateIfNeeded(): void {
    if (!this.path || !existsSync(this.path)) return
    try {
      if (statSync(this.path).size <= this.maxBytes) return
      renameSync(this.path, `${this.path}.1`)
    } catch {
      // ignore rotation errors
    }
  }
}
