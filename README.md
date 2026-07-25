# opencode-llm-router

[![npm version](https://img.shields.io/npm/v/opencode-llm-router.svg)](https://www.npmjs.com/package/opencode-llm-router)
[![CI](https://github.com/your-username/opencode-llm-router/actions/workflows/ci.yml/badge.svg)](https://github.com/your-username/opencode-llm-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Automatic, configurable multi-signal LLM router for [opencode](https://opencode.ai).**
Every prompt is analyzed — in milliseconds — by a fusion of local signals **and** a small AI classifier, then answered by the best model for the job. Cheap model for "hi", smart model for architecture, local model for your secrets.

```
 "hola 👋"                      →  trivial      →  gpt-4.1-nano      (fast & free-ish)
 "fix this TypeError in auth.ts" →  code         →  claude-sonnet-4-5  (your workhorse)
 "analyze this migration plan"   →  reasoning    →  o3 @ temp 0.1     (the big brain)
 "my card is 4242 4242..."       →  private      →  ollama/qwen3:8b   (never leaves your PC)
 "describe this screenshot"      →  vision       →  gpt-4.1           (image-capable)
```

## Why

You pay for (and wait for) your flagship model on **every single message** — including "ok", "thanks" and "what does this regex do?". This plugin classifies each message and routes it to the right tier automatically, while hard guardrails keep PII away from cloud providers. If it's not confident, it simply keeps the model you picked.

## Features

- **Small-AI classifier** — ambiguous prompts are classified by a fast, cheap model through any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, vLLM…). Cached, timeout-guarded, fail-open.
- **Many signals at once** — complexity heuristics, task type (code/math/creative/agentic), context length, required tools/modalities, custom regex rules, optional local **BERT** zero-shot classifier, and your own signal plugins.
- **PII & secret detection** — emails, credit cards (Luhn-verified), IBANs, SSNs, phones, AWS/GitHub/OpenAI keys, JWTs, private key blocks → veto-routed to a local model.
- **Capability-aware** — won't reroute to a vision model if your current one already sees images, nor to a long-context model if yours already fits. Won't route to models you don't have.
- **Custom rules with vetoes** — your regex guardrails always win over every other signal.
- **Per-category sampling params** — e.g. `temperature: 0.1` for reasoning, `0.9` for creative.
- **Transparent** — TUI toasts + a JSONL decision log (that never stores your prompt text).
- **Safe by design** — `suggest` mode to evaluate before trusting; low-confidence decisions keep your model; explicit variant choices are respected; the plugin fails open on any error.
- **Zero runtime dependencies** — plain TypeScript, runs inside opencode's plugin host. Optional `@huggingface/transformers` for BERT.

## How it works

```
                ┌───────────────────────── your message ─────────────────────────┐
                │                                                                │
   local signals (µs, free)                                   small AI (only when
   ├─ custom rules ─── veto? ──┐                               heuristics disagree)
   ├─ PII detectors ── veto? ──┤      ┌─────────────┐          task_type, complexity,
   ├─ tools needed ─── veto? ──┼─────▶│ FUSION      │◀───────── needs_tools, has_pii
   ├─ complexity              │ votes │ weighted    │  votes
   ├─ task type               ├──────▶│ categories  │
   ├─ context length          │       └──────┬──────┘
   ├─ BERT (optional)         │              ▼
   └─ your signal plugins     │     capability checks (vision? context? available?)
                               │              ▼
                               └──── confidence gate ──► route.message.model = …
```

The plugin hooks opencode's `chat.message` event and rewrites the message's model **before** the request is built; `chat.params` then applies the category's sampling parameters. When nothing is confident enough, nothing changes.

## Install

1. Add the plugin to your opencode config (`~/.config/opencode/opencode.json` globally, or `opencode.json` in a project):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-llm-router"]
   }
   ```

2. Create a config file — global at `~/.config/opencode/llm-router.json` or per-project at `<project>/.opencode/llm-router.json`. Start from the annotated example:

   ```bash
   # Linux / macOS
   curl -o ~/.config/opencode/llm-router.json \
     https://raw.githubusercontent.com/your-username/opencode-llm-router/main/llm-router.example.json
   ```

   ```powershell
   # Windows (PowerShell)
   Invoke-WebRequest -Uri "https://raw.githubusercontent.com/your-username/opencode-llm-router/main/llm-router.example.json" `
     -OutFile "$HOME/.config/opencode/llm-router.json"
   ```

3. **Edit `routes`** to models that exist in *your* connected providers, and set the classifier's API key env var (e.g. `OPENROUTER_API_KEY`).

4. **Quit and restart opencode** (config is loaded once at startup).

Start with `"mode": "suggest"` — the router shows a toast with what it *would* do on each message. When you like its judgment, switch to `"auto"`.

## Quick start (fully local, free, private)

No API key needed if you run [Ollama](https://ollama.com):

```jsonc
{
  "mode": "auto",
  "classifier": {
    "enabled": true,
    "baseURL": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "model": "qwen3:4b"
  },
  "routes": {
    "trivial": "ollama/qwen3:1.7b",
    "code": "anthropic/claude-sonnet-4-5",
    "private": "ollama/qwen3:8b"
  }
}
```

## Configuration reference

Config files are JSONC (comments + trailing commas OK). Merge order: built-in defaults < global file < project file < inline plugin options (`["opencode-llm-router", { … }]`). Any string of the exact form `"{env:VAR_NAME}"` is replaced by that environment variable.

| Key | Default | Description |
| --- | --- | --- |
| `mode` | `"auto"` | `"auto"` reroutes, `"suggest"` only notifies, `"off"` disables. |
| `routes` | `{}` | `category → "provider/model"` or `{ model, params }`. `"keep"` = never change. |
| `minConfidence` | `0.4` | Winner's normalized vote share required to reroute (0–1). |
| `skipAgents` | `[]` | Agents that are never rerouted (e.g. `["plan"]`). |
| `respectVariant` | `true` | Skip routing when you explicitly picked a model variant. |
| `notify` | `true` | Show a TUI toast on each routing decision. |
| `debug` | `false` | Verbose console logging. |

### `classifier` (the small AI)

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `baseURL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `apiKeyEnv` | `OPENROUTER_API_KEY` | Env var holding the API key. |
| `apiKey` | — | Direct key; supports `"{env:VAR}"`. |
| `model` | `google/gemini-2.5-flash-lite` | Small/fast/cheap classification model. |
| `timeoutMs` | `4000` | Aborts slow calls; routing continues without them. |
| `maxChars` | `4000` | Only this prefix of your prompt is classified. |
| `weight` | `2` | Classifier vote weight in the fusion. |
| `when` | `"uncertain"` | `"uncertain"` = only when heuristics disagree (no latency on obvious prompts). `"always"` = every message. |
| `uncertainMargin` | `0.15` | Normalized best-minus-second margin that counts as "uncertain". |
| `cacheTtlMinutes` | `60` | Result cache TTL (keyed by prompt hash). |
| `systemPrompt` | built-in | Full override of the classifier instructions. |
| `headers` | — | Extra HTTP headers for the endpoint. |

> **Privacy:** the classifier sees the (truncated) text of your prompt. Point `baseURL` at a local server (Ollama, LM Studio) for fully local classification. PII detection runs **before** the classifier is consulted, and PII vetoes always win.

### Signals

| Signal | What it does | Key options |
| --- | --- | --- |
| `complexity` | Heuristic trivial/simple/reasoning scoring (EN/ES aware) | `weight` |
| `taskType` | Keyword/regex buckets: code, math, creative, agentic | `weight` |
| `contextLength` | Votes `long_context` past `longChars` (~chars/4 tokens) | `weight`, `longChars` (24000) |
| `toolsNeeded` | Images → vision **veto**; files/URLs/@agents → votes | `weight` |
| `pii` | Regex + Luhn PII/credential detection → **veto** to `route` | `action`, `route`, `types` |
| `rules` | Your regexes: soft votes or hard vetoes (top priority) | `weight`, `list` |
| `bert` | Local zero-shot classification via transformers.js | `enabled`, `model`, `labels`, `labelMap`, `weight` |
| `custom` | Your own signal modules (`paths`) | `weight`, `paths` |

### Categories

`trivial`, `simple`, `code`, `reasoning`, `creative`, `vision`, `agentic`, `long_context`, `private`. Categories are just strings — custom rules and signals can introduce new ones as long as `routes` maps them.

### Custom rules

```jsonc
"rules": {
  "enabled": true,
  "weight": 3,
  "list": [
    // veto: short-circuits ALL other signals (even PII)
    { "name": "prod-guard", "match": "\\bprod(uction)?\\b", "route": "reasoning", "veto": true },
    // soft: casts a weighted vote
    { "name": "k8s", "match": "kubernetes|helm", "route": "code", "weight": 2, "flags": "i" }
  ]
}
```

### BERT classifier (optional)

Runs a zero-shot model **locally** with transformers.js:

```bash
npm i @huggingface/transformers   # in the plugin directory
```

```jsonc
"bert": { "enabled": true, "model": "Xenova/distilbert-base-uncased-mnli", "weight": 1.5 }
```

The first use downloads the model weights (~260 MB for the default MNLI model). If the dependency is missing, the signal disables itself with a warning — routing keeps working.

### Custom signal plugins

Point `signals.custom.paths` at JS/TS modules (relative to the project root or absolute). A signal receives the same context as built-ins and returns votes or a veto:

```ts
// .opencode/signals/security.ts
export default function ({ text }) {
  if (/\b(jwt|oauth|saml|oidc)\b/i.test(text)) {
    return { votes: { code: 0.8, reasoning: 0.4 }, reason: "auth domain" }
  }
  return null
}
```

```jsonc
"custom": { "enabled": true, "weight": 1, "paths": [".opencode/signals/security.ts"] }
```

Broken modules are skipped with a warning; they can never break routing.

## Decision log

Every decision is appended as one JSON line (default: `~/.local/state/opencode/llm-router/decisions.jsonl`, `%LOCALAPPDATA%\opencode\llm-router\decisions.jsonl` on Windows):

```json
{"ts":"2026-07-25T10:15:30.000Z","sessionID":"ses_…","agent":"build","action":"route","mode":"auto","category":"private","from":"anthropic/claude-sonnet-4-5","to":"ollama/qwen3:8b","confidence":1,"reason":"PII detected (email, credit_card) — routing to a private model","vetoedBy":"pii","classifierUsed":false,"scores":{},"signals":[{"name":"pii","reason":"PII: email, credit_card"}],"latencyMs":1}
```

**The log never contains prompt text** — only categories, models, scores, detector names and timings. Disable with `"log": { "enabled": false }`.

## FAQ

**Does it slow down my prompts?**
Local signals take microseconds. The small AI is only called when heuristics disagree (`when: "uncertain"`), with a 4 s timeout and a result cache — obvious messages never wait.

**What happens if the classifier is down / the key is wrong?**
Nothing bad. The call fails, heuristics decide, and if they're not confident either, your chosen model stays.

**What if I hate a routing decision mid-session?**
Pick a model variant explicitly — `respectVariant: true` makes the router step aside. Or add the agent to `skipAgents`, set the category route to `"keep"`, or flip to `"mode": "suggest"`.

**Can I use it without the small AI?**
Yes — `"classifier": { "enabled": false }` gives you a pure heuristic/rules router. You can also invert it: disable local signals and route on the classifier alone.

**Does it work with any provider?**
Routes use opencode's `provider/modelID` format, so any provider connected in opencode works. The classifier only needs an OpenAI-compatible chat endpoint.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test, 50 unit tests
```

The core engine (`src/router.ts`, `src/signals/*`, `src/classifier.ts`) has no opencode dependencies and is fully unit-tested; `src/index.ts` is a thin adapter over the plugin hooks.

## Contributing

Issues and PRs are welcome. Please add tests for new signals and keep the plugin dependency-free (optional peer deps for ML are fine).

## License

[MIT](LICENSE) © 2026 opencode-llm-router contributors
