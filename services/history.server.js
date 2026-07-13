import AppConfig from './config.server.js'

const MAX_RECENT_MESSAGES = AppConfig.api.maxRecentMessages ?? 16

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

// Full history stays untouched in the DB. This builds the trimmed version
// sent to OpenAI: any tool_result older than the recent window collapses
// to a short note — cart results and catalog results alike. Cart truth is
// never cached or summarized; the model is expected to call the real tool
// whenever it needs current cart state.
export function buildModelMessages(fullHistory) {
    const toolNameById = buildToolNameById(fullHistory)
    const cutoffIndex = Math.max(0, fullHistory.length - MAX_RECENT_MESSAGES)

    return fullHistory.map((message, index) => {
        if (!Array.isArray(message.content)) return message
        if (index >= cutoffIndex) return message

        const content = message.content.map((block) => {
            if (block.type !== 'tool_result') return block

            const toolName = toolNameById.get(block.tool_use_id)
            const isCartResult =
                AppConfig.tools.cartToolNames.includes(toolName)

            return isCartResult
                ? collapseCartResult(block)
                : collapseCatalogResult(block)
        })

        return { ...message, content }
    })
}

export default { buildModelMessages }
