/**
 * Signal: required tools / modalities.
 *
 * Looks at the message parts rather than the text:
 *   - image parts            -> veto to "vision" (hard requirement)
 *   - non-image file parts   -> "code" (attached code/data) + "long_context"
 *   - agent (@) mentions     -> "agentic"
 *   - URLs in text           -> "agentic" (likely needs web fetch)
 */

import type { Signal } from "../types.ts"

const URL_RE = /https?:\/\/[^\s)\]>"]+/i
const IMAGE_MIME = /^image\//i

export const toolsNeededSignal: Signal = (ctx) => {
  const votes: Record<string, number> = {}
  const reasons: string[] = []
  let imageCount = 0
  let fileCount = 0
  let agentMention = false

  for (const part of ctx.parts) {
    if (part.type === "file" || part.type === "image") {
      const mime = part.mime ?? ""
      const name = part.filename ?? part.url ?? ""
      if (IMAGE_MIME.test(mime) || /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)(\?|$)/i.test(name)) {
        imageCount++
      } else {
        fileCount++
      }
    }
    if (part.type === "agent") agentMention = true
  }

  if (imageCount > 0) {
    // Hard requirement: the answering model must accept image input.
    return {
      veto: { category: "vision", reason: `${imageCount} image(s) attached` },
      reason: `${imageCount} image(s) attached`,
      metadata: { images: imageCount },
    }
  }

  if (fileCount > 0) {
    votes["code"] = Math.max(votes["code"] ?? 0, 0.45)
    reasons.push(`${fileCount} file(s) attached`)
  }

  if (agentMention) {
    votes["agentic"] = Math.max(votes["agentic"] ?? 0, 0.9)
    reasons.push("@agent mention")
  }

  if (URL_RE.test(ctx.text)) {
    votes["agentic"] = Math.max(votes["agentic"] ?? 0, 0.5)
    reasons.push("URL in prompt")
  }

  if (Object.keys(votes).length === 0) return null
  return { votes, reason: reasons.join("; ") }
}
