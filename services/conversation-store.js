import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'

const serialize = (content) => JSON.stringify(content)
const deserialize = (content) => {
    try {
        return JSON.parse(content)
    } catch {
        return content
    }
}

export async function ensureConversation(conversationId, shop) {
    await prisma.conversation.upsert({
        where: { id: conversationId },
        update: {},
        create: { id: conversationId, shop },
    })
}

export async function getMessages(conversationId) {
    const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
    })

    return rows.map((row) => ({
        role: row.role,
        content: deserialize(row.content),
    }))
}

// content = model-facing content (unchanged shape/cost as before).
// displayContent = OPTIONAL full frontend payload (only meaningful for
// tool_result rows) — used purely for re-rendering product/cart cards on
// history reload. Never sent to the model.
export async function appendMessage(
    conversationId,
    role,
    content,
    displayContent = null
) {
    try {
        await prisma.message.create({
            data: {
                conversationId,
                role,
                content: serialize(content),
                displayContent:
                    displayContent != null ? serialize(displayContent) : null,
            },
        })
    } catch (error) {
        logger.error(
            {
                conversationId,
                role,
                err: {
                    message: error.message,
                    name: error.name,
                    stack: error.stack,
                },
            },
            'Failed to persist message'
        )
    }
}

// Rebuilds a UI-friendly turn sequence from raw DB rows:
//   [{ role:'user', text }, { role:'assistant', text, toolResults:[{tool,data}] }, ...]
// Works identically whether a turn came from the real AI loop (chatController)
// or a direct, AI-skipped action (e.g. the Add to Cart button) — both write
// the same tool_use/tool_result/text row shapes.
export async function getHistoryForClient(conversationId) {
    const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
    })

    const toolNameById = new Map()
    const turns = []
    let currentTurn = null

    const ensureBotTurn = () => {
        if (!currentTurn) {
            currentTurn = { role: 'assistant', text: '', toolResults: [] }
            turns.push(currentTurn)
        }
        return currentTurn
    }

    for (const row of rows) {
        const content = deserialize(row.content)

        // Plain user text -> starts a new turn.
        if (row.role === 'user' && typeof content === 'string') {
            turns.push({ role: 'user', text: content })
            currentTurn = null
            continue
        }

        // Assistant message: text and/or tool_use blocks.
        if (row.role === 'assistant' && Array.isArray(content)) {
            const turn = ensureBotTurn()
            for (const block of content) {
                if (block.type === 'text' && block.text) turn.text += block.text
                if (block.type === 'tool_use')
                    toolNameById.set(block.id, block.name)
            }
            continue
        }

        // Tool result envelope (role: user, content: [tool_result]).
        if (row.role === 'user' && Array.isArray(content)) {
            const toolResult = content.find((b) => b.type === 'tool_result')
            if (toolResult) {
                const turn = ensureBotTurn()
                const toolName =
                    toolNameById.get(toolResult.tool_use_id) || null
                const display = row.displayContent
                    ? deserialize(row.displayContent)
                    : deserialize(toolResult.content)
                turn.toolResults.push({ tool: toolName, data: display })
            }
            continue
        }
    }

    return turns
}

// One cart per conversation. This id is the only cart-related state we
// keep server-side — it's an opaque identifier, not derived cart content,
// so there's nothing here that can drift from reality.
export async function getCartId(conversationId) {
    const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { cartId: true },
    })
    return conversation?.cartId ?? null
}

export async function setCartId(conversationId, cartId) {
    try {
        await prisma.conversation.update({
            where: { id: conversationId },
            data: { cartId },
        })
    } catch (error) {
        logger.error(
            { conversationId, cartId, err: { message: error.message } },
            'Failed to persist cart id'
        )
    }
}

export default {
    ensureConversation,
    getMessages,
    getHistoryForClient,
    appendMessage,
    getCartId,
    setCartId,
}
