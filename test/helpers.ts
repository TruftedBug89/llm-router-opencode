import { DEFAULT_CONFIG, deepMerge } from "../src/config.ts"
import type { RouterConfig, SignalContext, SignalOutcome, SignalResult } from "../src/types.ts"

export function makeConfig(overrides: Record<string, unknown> = {}): RouterConfig {
  return deepMerge(structuredClone(DEFAULT_CONFIG), overrides)
}

export function makeCtx(config: RouterConfig, overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    text: "hello",
    parts: [],
    agent: "build",
    sessionID: "ses_test",
    currentModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    hasVariant: false,
    config,
    directory: process.cwd(),
    ...overrides,
  }
}

export function outcome(name: string, weight: number, result: SignalResult | null): SignalOutcome {
  return { name, weight, result, latencyMs: 1 }
}
