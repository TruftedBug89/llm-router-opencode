/**
 * Signal: task-type keyword/regex classifier.
 *
 * Buckets the prompt into "code", "reasoning" (math/logic), "creative",
 * "agentic" (multi-step tool use) or "simple" using bilingual (EN/ES)
 * keyword sets. Cheap and deterministic; the small-AI classifier refines
 * whatever this gets wrong.
 */

import type { Signal } from "../types.ts"

interface Bucket {
  category: string
  patterns: RegExp[]
  weight: number
}

const CODE_MARKERS: RegExp[] = [
  /```/,
  /\b(function|const|let|var|class|interface|enum|import|export|return|async|await|def|fn|pub\s+fn|impl|struct)\b/,
  /\b(typescript|javascript|python|rust|golang|\bgo\b|java\b|c\+\+|c#|rust|php|ruby|swift|kotlin|scala|sql|html|css|bash|shell|powershell)\b/i,
  /\b(error|exception|stack\s?trace|traceback|segfault|panic|undefined is not|cannot read|typeerror|syntaxerror|referenceerror|nullpointer)\b/i,
  /\b(npm|pnpm|yarn|bun|node|deno|pip|cargo|maven|gradle|docker|kubernetes|k8s|git\s)\b/i,
  /\b(compil|build|lint|test|deploy|debug|bug|fix|patch|regex|api|endpoint|sdk|cli)\b/i,
  /\b\w+\.(ts|tsx|js|jsx|py|rs|go|java|cpp|cc|c|h|cs|php|rb|swift|kt|sql|sh|bash|zsh|json|ya?ml|toml|xml|md|css|scss|html)\b/i,
  /\b(código|programa|función|depura|error de compilación|excepción)\b/i,
]

const MATH_MARKERS: RegExp[] = [
  /\b(equation|integral|derivative|derivada|matrix|matriz|vector|probability|probabilidad|statistic|estadística|theorem|teorema|proof|demostración|algebra|álgebra|calculus|cálculo|logarit|trigonometr|polynomial|polinomio)\b/i,
  /\b\d+\s*[-+*/^=]\s*\d+\b/,
  /[∫∑∏√π∞≈≠≤≥±]/,
  /\b(solve|resuelve|calcula|calculate|compute|demuestra|prove)\b.*\b(math|matemática|equation|ecuación|number|número)\b/i,
]

const CREATIVE_MARKERS: RegExp[] = [
  /\b(write|escribe|redacta|compose|crea|inventa)\b.*\b(story|historia|poem|poema|poetry|poesía|song|canción|lyrics|letra|novel|novela|tale|cuento|script|guion|guionista|essay|ensayo|blog|article|artículo|slogan|tagline)\b/i,
  /\b(brainstorm|lluvia de ideas|imagina|imagine|fiction|ficción|personaje|character)\b/i,
  /\b(marketing copy|copywriting|post de|tweet|caption|descripción de producto)\b/i,
]

const AGENTIC_MARKERS: RegExp[] = [
  /\b(implement|implementa|build|construye|create|crea|scaffold|genera)\b.*\b(app|aplicación|project|proyecto|feature|funcionalidad|sistema|system|service|servicio|api|endpoint|component|componente|plugin|módulo|module)\b/i,
  /\b(fix|arregla|corrige|update|actualiza|change|cambia|modify|modifica|add|añade|agrega|remove|elimina|delete|borra|rename|renombra|move|mueve)\b.*\b(file|archivo|code|código|function|función|class|clase|test|config|configuración)\b/i,
  /\b(run|ejecuta|install|instala|download|descarga|search|busca|find|encuentra|fetch|deploy|despliega|commit|push|pull request|pr\b)\b/i,
  /\b(and then|y luego|y después|after that|después de eso|next|a continuación)\b/i,
]

const BUCKETS: Bucket[] = [
  { category: "code", patterns: CODE_MARKERS, weight: 0.35 },
  { category: "reasoning", patterns: MATH_MARKERS, weight: 0.5 },
  { category: "creative", patterns: CREATIVE_MARKERS, weight: 0.5 },
  { category: "agentic", patterns: AGENTIC_MARKERS, weight: 0.35 },
]

const MAX_HITS = 8

function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g"
  return (text.match(new RegExp(re.source, flags)) ?? []).length
}

export const taskTypeSignal: Signal = (ctx) => {
  const text = ctx.text
  if (!text.trim()) return null

  const scores: Record<string, number> = {}
  const hits: string[] = []

  for (const bucket of BUCKETS) {
    let n = 0
    for (const re of bucket.patterns) n += countMatches(text, re)
    if (n > 0) {
      n = Math.min(n, MAX_HITS)
      // one solid marker already means something; extra hits add diminishing confidence
      scores[bucket.category] = Math.min(1, bucket.weight * (1 + Math.log10(n)))
      hits.push(`${bucket.category}×${n}`)
    }
  }

  if (Object.keys(scores).length === 0) return null

  // agentic prompts that also look like code: blend, don't double-cap
  if ((scores["agentic"] ?? 0) > 0 && (scores["code"] ?? 0) > 0) {
    scores["agentic"] = Math.min(1, (scores["agentic"] ?? 0) + 0.15)
  }

  return { votes: scores, reason: hits.join(", ") }
}
