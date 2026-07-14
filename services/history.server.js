import AppConfig from './config.server.js'
import { createToolService } from './tool.server.js'

const MAX_RECENT_MESSAGES = AppConfig.api.maxRecentMessages ?? 16
const toolService = createToolService()

function buildToolNameById(fullHistory) {
    const map = new Map()
    for (const message of fullHistory) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
            if (block.type === 'tool_use') map.set(block.id, block.name)
        }
    }
    return map
}

// Self-heal: if an assistant tool_use has no matching tool_result anywhere
// in history (e.g. a network failure or crash happened between writing the
// tool_use and writing its result), OpenAI rejects the ENTIRE request with
// a 400 — permanently blocking the conversation. We guard against that at
// the write sites (chatController / cartAddController now always write a
// result, even on hard failure), but this is a second line of defense: any
// tool_call_id still missing a response gets a synthetic error result
// injected here, every time, so one broken turn can never brick a
// conversation forever.
function healOrphanedToolCalls(fullHistory) {
    const respondedIds = new Set()
    for (const message of fullHistory) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
            if (block.type === 'tool_result')
                respondedIds.add(block.tool_use_id)
        }
    }

    const healed = []
    for (const message of fullHistory) {
        healed.push(message)
        if (!Array.isArray(message.content)) continue

        const orphanedIds = message.content
            .filter((b) => b.type === 'tool_use' && !respondedIds.has(b.id))
            .map((b) => b.id)

        for (const id of orphanedIds) {
            healed.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: id,
                        content: JSON.stringify({
                            error: {
                                message:
                                    'No result was recorded for this tool call.',
                            },
                        }),
                    },
                ],
            })
        }
    }
    return healed
}

function extractProductLabel(rawContent) {
    try {
        const parsed =
            typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent
        const titles = []
        if (Array.isArray(parsed?.products)) {
            titles.push(...parsed.products.map((p) => p.title).filter(Boolean))
        }
        if (parsed?.product?.title) titles.push(parsed.product.title)
        return titles.length ? titles.slice(0, 3).join(', ') : null
    } catch {
        return null
    }
}

function collapseCatalogResult(block) {
    const label = extractProductLabel(block.content)
    const content = label
        ? `[Earlier result for: ${label} — details omitted, call the tool again if you need current data]`
        : '[Older tool result omitted — call the tool again if you need current data]'
    return { ...block, content }
}

function collapseCartResult(block) {
    return {
        ...block,
        content:
            '[Earlier cart tool result — omitted. Call get_cart/update_cart again for current cart state, never assume it from here.]',
    }
}

// Shrinks a FULL tool_result payload down to what the model needs (strips
// the static UCP capability blob, unused variant/cart fields). This is a
// per-REQUEST optimization only — it never touches the DB, and it is
// recomputed from the full stored payload every time.
function shrinkForModel(block, toolName) {
    let parsed
    try {
        parsed =
            typeof block.content === 'string'
                ? JSON.parse(block.content)
                : block.content
    } catch {
        return block
    }

    // Hard errors are already tiny — pass through untouched.
    if (parsed?.error) return block

    const shrunk = toolService.buildModelToolResult(
        { structuredContent: parsed },
        toolName
    )
    return { ...block, content: JSON.stringify(shrunk) }
}

// Full history stays untouched in the DB (see conversation-store.js). This
// builds the trimmed version sent to OpenAI for THIS request only:
//  - orphaned tool_calls get a synthetic result so OpenAI never 400s
//  - recent tool_results (within the window) are shrunk but kept detailed
//  - older tool_results collapse to a short pointer, forcing a re-call
//    if the model actually needs current data
export function buildModelMessages(rawHistory) {
    const fullHistory = healOrphanedToolCalls(rawHistory)
    const toolNameById = buildToolNameById(fullHistory)
    const cutoffIndex = Math.max(0, fullHistory.length - MAX_RECENT_MESSAGES)

    return fullHistory.map((message, index) => {
        if (!Array.isArray(message.content)) return message

        const isRecent = index >= cutoffIndex
        const content = message.content.map((block) => {
            if (block.type !== 'tool_result') return block

            const toolName = toolNameById.get(block.tool_use_id)
            const isCartResult =
                AppConfig.tools.cartToolNames.includes(toolName)

            if (!isRecent) {
                return isCartResult
                    ? collapseCartResult(block)
                    : collapseCatalogResult(block)
            }

            return shrinkForModel(block, toolName)
        })

        return { ...message, content }
    })
}

export default { buildModelMessages }
