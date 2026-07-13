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

        const existingCartId = isNewConversation
            ? null
            : await getCartId(conversationId)

        const mcpClient = new MCPClient(`https://${shop}`, {
            cartId: existingCartId,
        })

        await mcpClient.connectToStorefrontServer()

        const availableTools = mcpClient.tools.filter((tool) =>
            AppConfig.tools.enabledToolNames.includes(tool.name)
        )

        const pastMessages = await getMessages(conversationId)
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

                        const toolUseResponse = await mcpClient.callTool(
                            content.name,
                            content.input
                        )

                        if (toolUseResponse.error) {
                            await toolService.handleToolError(toolUseResponse)
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

                        const modelFacingResult = toolUseResponse.error
                            ? toolUseResponse
                            : toolService.buildModelToolResult(
                                  toolUseResponse,
                                  content.name
                              )

                        const toolResultContent = [
                            {
                                type: 'tool_result',
                                tool_use_id: content.id,
                                content: JSON.stringify(modelFacingResult),
                            },
                        ]

                        conversationHistory.push({
                            role: 'user',
                            content: toolResultContent,
                        })
                        appendMessage(
                            conversationId,
                            'user',
                            toolResultContent,
                            toolUseResponse.error
                                ? null
                                : toolUseResponse.structuredContent
                        )

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
