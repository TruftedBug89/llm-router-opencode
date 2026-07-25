/**
 * opencode-llm-router — automatic, configurable multi-signal LLM router.
 *
 * How it works:
 *   - On init, the plugin injects an "auto-router" agent (a build clone you
 *     switch to with Tab) and a "/router" command into opencode's config.
 *   - `chat.message` fires for every new user message. If the agent is routed
 *     (see `onlyAgents`), we extract the text, run the local signals
 *     (complexity, task type, context length, tools, PII, custom rules,
 *     optional BERT, custom signal plugins), optionally ask a small model
 *     from your own opencode catalog to disambiguate, fuse everything, and —
 *     when the decision is "route" — rewrite `message.model`.
 *   - `chat.params` applies per-category sampling parameters (temperature,
 *     topP, ...) declared on the winning route.
 *
 * The plugin fails open: any internal error leaves the user's model choice
 * untouched.
 */

import type { Config as PluginConfig, Plugin } from "@opencode-ai/plugin"
import {
  CLASSIFIER_AGENT,
  DEFAULT_CONFIG,
  ROUTER_AGENT,
  ROUTER_COMMAND,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
} from "./config.ts"
import { classifyViaEndpoint } from "./classifier.ts"
import { classifyViaOpencode, isClassifierSession, type OpencodeClientLike } from "./opencode-backend.ts"
import { decide, resolveModel } from "./router.ts"
import { runLocalSignals } from "./signals/index.ts"
import { createCapabilities } from "./capabilities.ts"
import { DecisionLogger, defaultStateDir } from "./log.ts"
import type { Decision, ModelRef, RouterConfig, RouterPart, SignalContext } from "./types.ts"

const DECISION_TTL_MS = 30 * 60 * 1000
const MAX_SIGNAL_TEXT = 200_000

const ROUTER_COMMAND_TEMPLATE = `You are the configuration assistant for the opencode-llm-router plugin.

The user invoked /router with these arguments: "$ARGUMENTS"

## What this plugin does
It classifies every message sent in the "auto-router" agent (Tab to switch) using local signals (complexity, task type, context length, tools needed, PII, custom rules, optional BERT, custom signal plugins) plus a small classifier model, then routes the message to the best model.

## Config files (JSONC: comments and trailing commas allowed)
- global:  GLOBAL_CONFIG_PATH
- project: PROJECT_CONFIG_PATH  (wins over global)
Decisions log (JSONL, one line per decision, never contains prompt text): DECISIONS_LOG_PATH

## Keys you can change
- mode: "auto" (reroute) | "suggest" (only show what it would do) | "off"
- onlyAgents: ["auto-router"] by default; [] routes EVERY agent
- routes: category -> "provider/modelID" | ["fallback", "chain"] | { "model": ..., "params": { "temperature": n } } | "keep"
  Categories: trivial, simple, code, reasoning, creative, vision, agentic, long_context, private
- classifier: { enabled, source: "opencode"|"endpoint", model, when: "uncertain"|"always", weight }
- signals: per-signal { enabled, weight }; signals.rules.list: [{ name, match (regex), route, veto?, flags?, weight? }]
- signals.pii: { enabled, action: "route"|"off", route: "private" }
- notify, debug, minConfidence (0-1), respectVariant, skipAgents

## Model IDs
Use the user's OWN catalog (never invent IDs): zen models are "opencode/<id>" (free ones include big-pickle, mimo-v2.5-free, deepseek-v4-flash-free, nemotron-3-ultra-free), Go catalog is "opencode-go/<id>". Suggest fallback chains so rotation of free models never breaks routing.

## Behavior
- "status" or empty args: read both config files (if present) and the last ~15 lines of the decisions log; summarize mode, routes, classifier, and the most recent routing decisions.
- A change request: read the file, apply the MINIMAL edit keeping valid JSONC, show the before/after, and remind the user to QUIT AND RESTART opencode (config is loaded once at startup).
- "help": show this summary.
Never paste API keys or secrets into the config; use "{env:VAR_NAME}" placeholders instead.`

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

function modelChainLabel(model: string | string[]): string {
  return Array.isArray(model) ? model.join(" → ") : model
}

const plugin: Plugin = async ({ client, directory, worktree }, options) => {
  const root = worktree ?? directory
  const { config, sources, warnings } = loadConfig(root, options as Record<string, unknown> | undefined)
  const logger = new DecisionLogger(config.log)
  const capabilities = await createCapabilities(client)

  const debug = (message: string): void => {
    if (config.debug) console.log(`[llm-router] ${message}`)
  }

  // -- resolve the classifier model chain once at startup -------------------
  let classifierModel: ModelRef | null = null
  if (config.classifier.enabled && config.classifier.source === "opencode") {
    classifierModel = resolveModel(config.classifier.model, capabilities.lookup)?.model ?? null
    if (!classifierModel) {
      console.warn(
        `[llm-router] none of the classifier models is available (${modelChainLabel(config.classifier.model)}); classifier disabled`,
      )
    }
  }

  const classifyFn =
    !config.classifier.enabled || (config.classifier.source === "opencode" && !classifierModel)
      ? undefined
      : config.classifier.source === "opencode"
        ? (text: string, cfg: RouterConfig["classifier"]) =>
            classifyViaOpencode(client as unknown as OpencodeClientLike, text, cfg, classifierModel!, CLASSIFIER_AGENT)
        : classifyViaEndpoint

  for (const warning of warnings) console.warn(warning)
  if (config.mode !== "off") {
    const resolvedRoutes = Object.entries(config.routes)
      .map(([category, route]) => {
        const target = typeof route === "string" ? route : route.model
        if (target === "keep") return `${category}=keep`
        const resolved = resolveModel(target, capabilities.lookup)
        return resolved ? `${category}=${fmt(resolved.model)}` : `${category}=UNAVAILABLE`
      })
      .join(" ")
    console.log(
      `[llm-router] active (mode=${config.mode}, agents=${config.onlyAgents.length > 0 ? config.onlyAgents.join(",") : "all"}, ` +
        `classifier=${classifyFn ? (config.classifier.source === "opencode" ? fmt(classifierModel!) : "endpoint") : "off"}, ` +
        `catalog=${capabilities.size} models, config=${sources.length > 0 ? sources.join(" + ") : "defaults"})`,
    )
    console.log(`[llm-router] routes: ${resolvedRoutes}`)
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
    if (isClassifierSession(input.sessionID)) return // never route our own classifier calls

    const agent = output.message.agent ?? input.agent ?? "unknown"
    if (config.onlyAgents.length > 0 && !config.onlyAgents.includes(agent)) {
      debug(`skipped: agent "${agent}" not in onlyAgents`)
      return
    }
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
      decision = await decide({ ctx, outcomes, classifyFn, capabilities: capabilities.lookup })
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
    config: async (cfg: PluginConfig) => {
      try {
        cfg.agent ??= {}
        // Tab-switchable mode: exactly like build, but routed by this plugin.
        cfg.agent[ROUTER_AGENT] ??= {
          description: "Like build, but every message is auto-routed to the best model (opencode-llm-router)",
          mode: "primary",
          color: "#FFB86C",
        }
        // Hidden single-step agent that powers the small-AI classifier calls.
        cfg.agent[CLASSIFIER_AGENT] ??= {
          description: "Internal: classifies prompts for opencode-llm-router (do not use directly)",
          mode: "subagent",
          maxSteps: 1,
          hidden: true,
          permission: { edit: "deny", bash: "deny", webfetch: "deny", doom_loop: "deny" },
        }
        cfg.command ??= {}
        cfg.command[ROUTER_COMMAND] ??= {
          description: "Configure opencode-llm-router: status, modes, routes, models",
          template: ROUTER_COMMAND_TEMPLATE.replaceAll("GLOBAL_CONFIG_PATH", globalConfigPath())
            .replaceAll("PROJECT_CONFIG_PATH", projectConfigPath(root))
            .replaceAll("DECISIONS_LOG_PATH", config.log.path ?? `${defaultStateDir()}/decisions.jsonl`),
        }
      } catch (err) {
        console.warn(`[llm-router] could not inject agent/command: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

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
