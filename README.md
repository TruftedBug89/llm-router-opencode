# opencode-llm-router

> [!WARNING]
> **Project Status:** ⚠️ **In Development / Not Working**  
> *This repository is currently under development and is not fully functional yet. This status must not be changed by AI unless explicitly instructed by the repository owner.*


[![npm version](https://img.shields.io/npm/v/opencode-llm-router.svg)](https://www.npmjs.com/package/opencode-llm-router)
[![CI](https://github.com/TruftedBug89/llm-router-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/TruftedBug89/llm-router-opencode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Automatic LLM router for [opencode](https://opencode.ai).** Every message is analyzed in milliseconds by a fusion of local signals **plus a small AI from your own opencode catalog**, then answered by the best model for the job. Free models for the small stuff, your best models for the hard stuff, a private lane for your secrets.

Zero configuration needed: routes are **dynamic selectors resolved against your live model catalog** (zen free, Go, whatever you connect) — no hardcoded model IDs, nothing goes stale when model lists rotate.

## Install (2 minutes)

**1.** Add the plugin to `~/.config/opencode/opencode.json` (or your project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-llm-router"]
}
```

**2.** Quit and restart opencode.

**3.** Press **Tab** until you reach the new **`auto-router`** mode (it's `build` + routing) and chat normally. Done. ✅

You'll see a toast on every routed message. That's it — free zen models answer the trivial stuff, your best available models get the hard work.

> Prefer evaluating first? Create `~/.config/opencode/llm-router.json` with `{ "mode": "suggest" }` — the router will only *show* what it would do. Flip to `"auto"` when you trust it.

## Using it

| You do | What happens |
| --- | --- |
| **Tab → `auto-router`** | Messages in this mode are routed. `build` and `plan` stay untouched. |
| **`/router`** | Configure the plugin from inside opencode: `/router status`, or ask for any change ("route code to kimi-k3", "turn debug on"). The agent edits the JSONC config for you (restart needed). |
| **`/router status`** | See current mode, routes, classifier and your latest routing decisions. |

## What it does

```
 "hola 👋"                        → trivial      → cheapest FREE model in your catalog
 "fix this TypeError in auth.ts"  → code         → best coding model you have
 "analyze this migration plan"    → reasoning    → strongest model @ temperature 0.1
 "my card is 4242 4242..."        → private      → free/local lane (PII never upgrades)
 "describe this screenshot"       → vision       → first image-capable model available
```

If it's not confident, it keeps the model you picked. If you pick a model variant explicitly, it steps aside. If anything breaks, it fails open. You're never worse off than without the plugin.

## How it works

```
                ┌─────────────────────── your message ───────────────────────┐
   local signals (µs, free)                                    small AI (only when
   ├─ custom rules ─── veto? ──┐     ┌──────────────┐          heuristics disagree)
   ├─ PII detectors ── veto? ──┤     │   FUSION     │          a model from YOUR
   ├─ tools needed ─── veto? ──┼────▶│  weighted    │◀──────── opencode catalog:
   ├─ complexity               │     │  categories  │          task_type, complexity,
   ├─ task type                ├────▶└──────┬───────┘          needs_tools, has_pii
   ├─ context length           │            ▼
   ├─ BERT (optional, local)   │   capability checks (vision? context? available?)
   └─ your signal plugins      │            ▼
                                └──── confidence gate ──► message.model = routed
```

- Hooks opencode's `chat.message` (rewrites the model before the request is built) and `chat.params` (applies per-category temperature/topP/…).
- The small-AI classifier runs through opencode itself (a hidden single-step agent + a throwaway session per call, cleaned up after). No external endpoints, no extra keys. Results are cached; calls have a timeout; failures just skip the AI vote.
- The model catalog refreshes itself in the background (60 s TTL), so rotated free models and new Go models are picked up automatically.

## Features

- **Dynamic model selection** — routes are `{ auto }` selectors over your live catalog (freeOnly, regex preferences, provider priority, vision, minContext, pick largest/smallest). Exact IDs and fallback chains are supported too.
- **8+ signals fused per message** — complexity, task type, context length, tools needed, PII/secrets, your regex rules (with vetoes), optional local BERT, your own signal plugins.
- **Small-AI classifier** — disambiguates uncertain prompts using your own catalog (default: the cheapest free model available). `when: "uncertain"` means zero added latency on obvious messages.
- **PII & secret firewall** — emails, credit cards (Luhn-verified), IBANs, SSNs, phones, AWS/GitHub/OpenAI keys, JWTs, private-key blocks → hard veto into the `private` route.
- **Capability-aware** — won't reroute to a vision model if your current one already sees images, nor to a long-context model if yours already fits, nor to models you don't have.
- **`auto-router` agent + `/router` command** — Tab to opt in per session; configure without leaving the TUI.
- **Transparent** — toasts + a JSONL decision log that never stores prompt text.
- **Zero runtime dependencies.**

## Configuration

Optional — defaults work out of the box. Files are JSONC (comments OK), merged in this order: defaults < `~/.config/opencode/llm-router.json` < `<project>/.opencode/llm-router.json` < inline plugin options. See [`llm-router.example.json`](llm-router.example.json) for the fully annotated file.

| Key | Default | Description |
| --- | --- | --- |
| `mode` | `"auto"` | `"auto"` reroutes · `"suggest"` only notifies · `"off"` disables |
| `onlyAgents` | `["auto-router"]` | Only these agents are routed. `[]` = route every agent |
| `skipAgents` | `["llm-router-classifier"]` | Never routed |
| `routes` | dynamic selectors | category → target (see below) |
| `minConfidence` | `0.4` | Winner's vote share required to reroute |
| `respectVariant` | `true` | Skip routing when you explicitly pick a model variant |
| `notify` | `true` | Toast on each decision |
| `debug` | `false` | Verbose console logging |

### Route targets — 3 ways

```jsonc
"routes": {
  // 1. dynamic selector (default): resolved against your live catalog
  "code": { "model": { "auto": { "providers": ["opencode-go", "opencode"], "prefer": ["code", "kimi"] } } },
  // 2. exact model or fallback chain
  "simple": ["opencode-go/kimi-k2.5", "opencode/big-pickle"],
  // 3. sampling params on any object route · "keep" disables a category
  "reasoning": { "model": { "auto": { "prefer": ["k3", "ultra", "max"] } }, "params": { "temperature": 0.1 } },
  "vision": "keep"
}
```

Selector fields: `prefer` (ordered regexes matched against model id **and** display name), `freeOnly`, `providers` (priority order), `vision`, `minContext`, `pick` (`first` | `largest` | `smallest`). Deprecated models are always excluded.

Categories: `trivial` · `simple` · `code` · `reasoning` · `creative` · `vision` · `agentic` · `long_context` · `private`.

### The small AI (`classifier`)

```jsonc
"classifier": {
  "enabled": true,
  "source": "opencode",                                  // uses YOUR catalog — default
  "model": { "auto": { "freeOnly": true, "prefer": ["nano", "mini", "pickle"] } },
  "when": "uncertain",        // only when heuristics disagree ("always" = every message)
  "weight": 2, "timeoutMs": 6000, "cacheTtlMinutes": 60
}
```

`source: "endpoint"` switches to a raw OpenAI-compatible endpoint (Ollama, OpenRouter, LM Studio…) with `baseURL` / `apiKey` / `model`. Note: with `"source": "opencode"` the prompt text never leaves your opencode session flow.

### Signals

| Signal | What it does |
| --- | --- |
| `complexity` | Heuristic trivial/simple/reasoning scoring (EN/ES) |
| `taskType` | Keyword buckets: code, math, creative, agentic |
| `contextLength` | Votes `long_context` past `longChars` |
| `toolsNeeded` | Images → vision veto; files/URLs/@agents → votes |
| `pii` | PII/credential detection → veto to `private` (`action`, `types`) |
| `rules` | Your regexes: votes or vetoes — top priority |
| `bert` | Optional local zero-shot classification (`npm i @huggingface/transformers`) |
| `custom` | Your own signal modules via `paths` |

```jsonc
"rules": { "list": [
  { "name": "prod-guard", "match": "\\bprod(uction)?\\b", "route": "reasoning", "veto": true },
  { "name": "k8s", "match": "kubernetes|helm", "route": "code" }
] }
```

```ts
// .opencode/signals/security.ts  →  "custom": { "paths": [".opencode/signals/security.ts"] }
export default function ({ text }) {
  return /\b(jwt|oauth|oidc)\b/i.test(text) ? { votes: { code: 0.8 }, reason: "auth domain" } : null
}
```

## Decision log

One JSON line per decision at `~/.local/state/opencode/llm-router/decisions.jsonl` (`%LOCALAPPDATA%\opencode\llm-router\decisions.jsonl` on Windows). **It never contains prompt text** — only categories, models, scores, detector names and timings. `/router status` summarizes it for you.

## FAQ

**Does it slow down my prompts?** Local signals take microseconds. The small AI only runs when heuristics disagree, with a timeout and a result cache.

**What if the classifier fails or a model disappears?** That decision falls back to heuristics; low confidence keeps your model. Routes re-resolve against the live catalog every time, so rotated/removed models are skipped automatically.

**How do I route EVERY mode, not just auto-router?** `"onlyAgents": []`.

**How do I go full manual on one category?** Set it to an exact model (`"code": "opencode-go/kimi-k3"`) or `"keep"`.

**Is the `private` route really private?** Only if you point it at a local model (e.g. `"ollama/qwen3:8b"`). The default uses free zen models — same cloud the rest of your chat already goes to, never a *new* destination.

## Development

```bash
npm install
npm run typecheck
npm test          # 70 unit tests (node:test)
```

The engine (`src/router.ts`, `src/signals/*`, `src/classifier.ts`, `src/opencode-backend.ts`) has no opencode dependencies and is fully unit-tested; `src/index.ts` is a thin adapter over the plugin hooks.

## License

[MIT](LICENSE) © 2026 opencode-llm-router contributors
