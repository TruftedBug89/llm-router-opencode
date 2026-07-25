/**
 * opencode-llm-router — automatic, configurable multi-signal LLM router.
 *
 * How it works:
 *   - `chat.message` fires for every new user message. We extract the text,
 *     run the local signals (complexity, task type, context length, tools,
 *     PII, custom rules, optional BERT, custom signal plugins), optionally
 *     call a small AI to disambiguate, fuse everything, and — when the
 *     decision is "route" — rewrite `message.model`. opencode then answers
 *     that message with the routed model.
 *   - `chat.params` applies per-category sampling parameters (temperature,
 *     topP, ...) declared on the winning route.
 *
 * The plugin fails open: any internal error leaves the user's model choice
 * untouched.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config.ts"
import { classify } from "./classifier.ts"
import { decide } from "./router.ts"
import { runLocalSignals } from "./signals/index.ts"
import { createCapabilities } from "./capabilities.ts"
import { DecisionLogger } from "./log.ts"
import type { Decision, RouterConfig, RouterPart, SignalContext } from "./types.ts"

const DECISION_TTL_MS = 30 * 60 * 1000
const MAX_SIGNAL_TEXT = 200_000

interface ChatMessageInput {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  messageID?: string
  variant?: string
}

interface ChatMessageOutput {
  message: {
    id: string
    agent?: string
    model?: { providerID: string; modelID: string; variant?: string }
  }
  parts: unknown[]
}

function extractText(parts: RouterPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic && typeof part.text === "string") {
      chunks.push(part.text)
    }
  }
  return chunks.join("\n\n").slice(0, MAX_SIGNAL_TEXT)
}

function fmt(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`
}

const plugin: Plugin = async ({ client, directory, worktree }, options) => {
  const root = worktree ?? directory
  const { config, sources, warnings } = loadConfig(root, options as Record<string, unknown> | undefined)
  const logger = new DecisionLogger(config.log)
  const capabilities = await createCapabilities(client)

  const debug = (message: string): void => {
    if (config.debug) console.log(`[llm-router] ${message}`)
  }

  for (const warning of warnings) console.warn(warning)
  if (config.mode !== "off") {
    console.log(
      `[llm-router] active (mode=${config.mode}, routes=${Object.keys(config.routes).length}, ` +
        `classifier=${config.classifier.enabled ? config.classifier.model : "off"}, ` +
        `catalog=${capabilities.size} models, config=${sources.length > 0 ? sources.join(" + ") : "defaults"})`,
    )
    if (capabilities.size > 0) {
      for (const [category, route] of Object.entries(config.routes)) {
        const target = typeof route === "string" ? route : route.model
        if (target === "keep") continue
        const slash = target.indexOf("/")
        if (slash <= 0) continue
        const hit = capabilities.lookup({ providerID: target.slice(0, slash), modelID: target.slice(slash + 1) })
        if (hit?.exists === false) {
          console.warn(`[llm-router] route "${category}" targets ${target}, which is not in your provider catalog`)
        }
      }
    }
  }

  const decisions = new Map<string, { decision: Decision; expires: number }>()
  const remember = (messageID: string, decision: Decision): void => {
    const now = Date.now()
    for (const [key, value] of decisions) {
      if (value.expires < now) decisions.delete(key)
    }
    decisions.set(messageID, { decision, expires: now + DECISION_TTL_MS })
  }

  const toast = async (message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> => {
    try {
      const tui = (client as unknown as Record<string, unknown>)["tui"] as
        | { showToast?: (req: unknown) => Promise<unknown> }
        | undefined
      await tui?.showToast?.({ body: { title: "llm-router", message, variant, duration: 4000 } })
    } catch {
      // TUI not attached (headless run) — ignore
    }
  }

  const routeMessage = async (input: ChatMessageInput, output: ChatMessageOutput): Promise<void> => {
    if (config.mode === "off") return

    const agent = output.message.agent ?? input.agent ?? "unknown"
    if (config.skipAgents.includes(agent)) {
      debug(`skipped: agent "${agent}" is in skipAgents`)
      return
    }

    const variant = input.variant ?? output.message.model?.variant
    if (config.respectVariant && variant) {
      debug(`skipped: explicit model variant "${variant}"`)
      return
    }

    const parts = (output.parts ?? []) as RouterPart[]
    const text = extractText(parts)
    if (text.trim().length === 0 && parts.length === 0) return

    const ctx: SignalContext = {
      text,
      parts,
      agent,
      sessionID: input.sessionID,
      currentModel: output.message.model
        ? { providerID: output.message.model.providerID, modelID: output.message.model.modelID }
        : undefined,
      hasVariant: variant !== undefined,
      config,
      directory: root,
    }

    let decision: Decision
    try {
      const outcomes = await runLocalSignals(ctx)
      decision = await decide({ ctx, outcomes, classifyFn: classify, capabilities: capabilities.lookup })
    } catch (err) {
      // fail open: never touch the message if the engine blows up
      console.warn(`[llm-router] routing failed (${err instanceof Error ? err.message : String(err)}); keeping current model`)
      return
    }

    remember(output.message.id, decision)

    const from = ctx.currentModel ? fmt(ctx.currentModel) : "default"
    logger.write({
      ts: new Date().toISOString(),
      sessionID: input.sessionID,
      agent,
      action: decision.action,
      mode: config.mode,
      category: decision.category,
      from,
      to: decision.model ? fmt(decision.model) : undefined,
      confidence: decision.confidence,
      reason: decision.reason,
      vetoedBy: decision.vetoedBy,
      classifierUsed: decision.classifierUsed,
      classification: decision.classification,
      scores: decision.scores,
      signals: decision.signals,
      latencyMs: decision.latencyMs,
    })
    debug(
      `${decision.action.toUpperCase()} ${decision.category ?? "-"} | ${from} -> ${decision.model ? fmt(decision.model) : from} | ${decision.reason} | ${decision.latencyMs}ms`,
    )

    if (decision.action !== "route" || !decision.model) return

    const to = fmt(decision.model)
    if (config.mode === "suggest") {
      if (config.notify) await toast(`would route: ${decision.category} → ${to}`, "info")
      return
    }

    output.message.model = { providerID: decision.model.providerID, modelID: decision.model.modelID }
    if (config.notify) await toast(`${decision.category} → ${to}`, "success")
  }

  return {
    "chat.message": async (input, output) => {
      await routeMessage(input as ChatMessageInput, output as unknown as ChatMessageOutput)
    },

    "chat.params": async (input, output) => {
      try {
        const messageID = (input.message as { id?: string }).id
        if (!messageID) return
        const hit = decisions.get(messageID)
        if (!hit || hit.decision.action !== "route" || !hit.decision.params) return
        const params = hit.decision.params
        if (params.temperature !== undefined) output.temperature = params.temperature
        if (params.topP !== undefined) output.topP = params.topP
        if (params.topK !== undefined) output.topK = params.topK
        if (params.maxOutputTokens !== undefined) output.maxOutputTokens = params.maxOutputTokens
        if (params.options) output.options = { ...output.options, ...params.options }
      } catch {
        // params tuning is best-effort
      }
    },

    dispose: async () => {
      decisions.clear()
    },
  }
}

export default plugin
export type { RouterConfig } from "./types.ts"
export { DEFAULT_CONFIG } from "./config.ts"
