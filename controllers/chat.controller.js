import { randomUUID } from 'node:crypto'
import MCPClient from '../services/mcp-client.js'
import { createOpenAIService } from '../services/openai.server.js'
import { createToolService } from '../services/tool.server.js'
import AppConfig from '../services/config.server.js'
import { buildModelMessages } from '../services/history.server.js'
import {
    ensureConversation,
    appendMessage,
    getMessages,
    getMaxMessagesForShop,
    getCartId,
    setCartId,
} from '../services/conversation-store.js'

export default async function chatController(req, res) {
    const { shop, message } = req.body
    let { conversationId } = req.body

    if (!message)
        return res
            .status(400)
            .json({ error: AppConfig.errorMessages.missingMessage })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    const openaiService = createOpenAIService()
    const toolService = createToolService()

    try {
        const isNewConversation = !conversationId
        if (isNewConversation) conversationId = randomUUID()

        await ensureConversation(conversationId, shop)
        if (isNewConversation) send({ type: 'conversation_id', conversationId })

        // --- Max messages per conversation guard --------------------------------
        // Only counts "real" turns: the visitor's own typed messages (role:'user',
        // string content) and the assistant's replies (role:'assistant'). Tool_result
        // rows (role:'user', array content) don't count against the merchant's limit.
        const pastMessages = await getMessages(conversationId)
        const qualifyingMessageCount = pastMessages.filter((m) => {
            if (m.role === 'user') return typeof m.content === 'string'
            if (m.role === 'assistant') {
                return (
                    Array.isArray(m.content) &&
                    m.content.some(
                        (block) => block.type === 'text' && block.text
                    )
                )
            }
            return false
        }).length

        const maxMessages = await getMaxMessagesForShop(shop)
        if (qualifyingMessageCount >= maxMessages) {
            send({
                type: 'limit_reached',
                error: AppConfig.errorMessages.conversationLimitReached,
            })
            return
        }

        const existingCartId = isNewConversation
            ? null
            : await getCartId(conversationId)

        const mcpClient = new MCPClient(`https://${shop}`, {
            cartId: existingCartId,
        })

        await mcpClient.connectToStorefrontServer()

        const availableTools = mcpClient.tools.filter((tool) => {
            if (!AppConfig.tools.enabledToolNames.includes(tool.name))
                return false
            // Once a cart exists, create_cart must never be offered again — the
            // model choosing it (instead of update_cart) silently starts a brand
            // new cart and orphans everything already in it.
            if (tool.name === 'create_cart' && existingCartId) return false
            return true
        })

        await appendMessage(conversationId, 'user', message)

        let conversationHistory = [
            ...pastMessages,
            { role: 'user', content: message },
        ]
        let finalMessage = { stop_reason: null }
        let pendingToolResults = []

        while (finalMessage.stop_reason !== 'end_turn') {
            finalMessage = await openaiService.streamConversation(
                {
                    messages: buildModelMessages(conversationHistory),
                    tools: availableTools,
                },
                {
                    onText: (chunk) => {
                        send({ type: 'chunk', chunk })
                    },

                    onMessage: (msg) => {
                        conversationHistory.push({
                            role: msg.role,
                            content: msg.content,
                        })
                        appendMessage(conversationId, msg.role, msg.content)
                        send({ type: 'message_complete' })

                        if (pendingToolResults.length) {
                            for (const result of pendingToolResults) {
                                send({ type: 'tool_result', ...result })
                            }
                            pendingToolResults = []
                        }
                    },

                    onToolUse: async (content) => {
                        send({
                            type: 'tool_use',
                            tool_use_message: `Calling tool: ${content.name}`,
                        })

                        // Never let a hard failure (network error, MCP
                        // timeout, etc.) skip writing a tool_result — an
                        // unanswered tool_call_id permanently breaks every
                        // future turn in this conversation with OpenAI.
                        let toolUseResponse
                        try {
                            toolUseResponse = await mcpClient.callTool(
                                content.name,
                                content.input
                            )
                        } catch (err) {
                            toolUseResponse = {
                                error: {
                                    message: err.message || 'Tool call failed',
                                },
                            }
                        }

                        try {
                            if (toolUseResponse.error) {
                                await toolService.handleToolError(
                                    toolUseResponse
                                )
                            } else {
                                const result = toolService.handleToolSuccess(
                                    toolUseResponse,
                                    content.name
                                )
                                if (result) pendingToolResults.push(result)

                                if (
                                    AppConfig.tools.cartToolNames.includes(
                                        content.name
                                    ) &&
                                    mcpClient.cartId !== existingCartId
                                ) {
                                    await setCartId(
                                        conversationId,
                                        mcpClient.cartId
                                    )
                                }
                            }
                        } catch (err) {
                            console.error(err)
                        }

                        // Always persist the FULL payload — identical to
                        // what the frontend receives. Shrinking for the
                        // model happens later, in buildModelMessages(), and
                        // never touches what's stored here.
                        const toolResultContent = [
                            {
                                type: 'tool_result',
                                tool_use_id: content.id,
                                content: JSON.stringify(
                                    toolUseResponse.error
                                        ? toolUseResponse
                                        : toolUseResponse.structuredContent
                                ),
                            },
                        ]

                        conversationHistory.push({
                            role: 'user',
                            content: toolResultContent,
                        })
                        appendMessage(conversationId, 'user', toolResultContent)

                        send({ type: 'new_message' })
                    },
                }
            )
        }

        send({ type: 'end_turn' })
    } catch (error) {
        console.error(error)
        send({
            type: 'error',
            error: AppConfig.errorMessages.genericError,
            details: error.message,
        })
    } finally {
        res.end()
    }
}
