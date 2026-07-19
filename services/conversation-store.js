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

export async function getUsageContextForShop(shop) {
    const session = await prisma.session.findFirst({
        where: { shop },
        select: {
            id: true,
            usagesettings: true,
            aipersonasettings: { select: { tone: true } },
        },
    })

    return {
        sessionId: session?.id ?? null,
        usageSettings: session?.usagesettings ?? {
            maxMessagesPerConversation: 15,
            maxMessagesPerVisitor: 100,
            resetPeriod: 'hour',
        },
        tone: session?.aipersonasettings?.tone ?? 'standard',
    }
}

// content is always the FULL, untouched payload — identical to what the
// frontend receives over SSE. Nothing is shrunk or summarized before it
// hits the DB. Token-saving shrinkage happens ONLY at request time, in
// history.server.js's buildModelMessages(), right before a call to OpenAI.
export async function appendMessage(conversationId, role, content) {
    try {
        await prisma.message.create({
            data: { conversationId, role, content: serialize(content) },
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
// Works identically for AI-driven turns and direct AI-skipping actions
// (e.g. the Add to Cart button) — both write the same tool_use /
// tool_result / text row shapes.
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

        if (row.role === 'user' && typeof content === 'string') {
            turns.push({ role: 'user', text: content })
            currentTurn = null
            continue
        }

        if (row.role === 'assistant' && Array.isArray(content)) {
            const turn = ensureBotTurn()
            for (const block of content) {
                if (block.type === 'text' && block.text) turn.text += block.text
                if (block.type === 'tool_use')
                    toolNameById.set(block.id, block.name)
            }
            continue
        }

        if (row.role === 'user' && Array.isArray(content)) {
            const toolResult = content.find((b) => b.type === 'tool_result')
            if (toolResult) {
                const turn = ensureBotTurn()
                const toolName =
                    toolNameById.get(toolResult.tool_use_id) || null
                turn.toolResults.push({
                    tool: toolName,
                    data: deserialize(toolResult.content),
                })
            }
            continue
        }
    }

    return turns
}

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
