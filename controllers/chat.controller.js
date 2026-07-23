import { randomUUID } from 'node:crypto'
import MCPClient from '../services/mcp-client.js'
import { createOpenAIService } from '../services/openai.server.js'
import { createToolService } from '../services/tool.server.js'
import AppConfig from '../services/config.server.js'
import { buildModelMessages } from '../services/history.server.js'
import {
    getVisitorIp,
    getResetPeriodMs,
    checkAndIncrementVisitorUsage,
} from '../services/usage-limits.server.js'
import {
    ensureConversation,
    appendMessage,
    getMessages,
    getUsageContextForShop,
    getCartId,
    setCartId,
} from '../services/conversation-store.js'
import { logger } from '../config/logger.js'
import { searchPolicies } from '../services/policy.server.js'
import {
    resolvePromptType,
    sanitizeCustomInstructions,
} from '../services/persona.server.js'
import {
    getValidCustomerToken,
    startCustomerAuth,
} from '../services/customer-account.server.js'
import { LOCAL_TOOLS } from '../services/tool-schemas.js'

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

        const [
            pastMessages,
            { sessionId, usageSettings, tone, customInstructions },
        ] = await Promise.all([
            getMessages(conversationId),
            getUsageContextForShop(shop),
        ])

        const promptType = resolvePromptType(tone)
        const safeCustomInstructions =
            sanitizeCustomInstructions(customInstructions)

        // --- Max messages per conversation guard --------------------------------
        const qualifyingMessageCount = pastMessages.filter(
            (m) => m.role === 'user' && typeof m.content === 'string'
        ).length

        if (
            qualifyingMessageCount >= usageSettings.maxMessagesPerConversation
        ) {
            send({
                type: 'limit_reached',
                error: AppConfig.errorMessages.conversationLimitReached,
            })
            return
        }

        // --- Max total messages per visitor (rolling window, IP-based) ----------
        // sessionId missing (no offline session row yet for this shop) — fail
        // open rather than crash; this shouldn't happen for an installed app.
        if (sessionId) {
            const visitorIp = getVisitorIp(req)
            const resetPeriodMs = getResetPeriodMs(usageSettings.resetPeriod)
            const visitorCheck = await checkAndIncrementVisitorUsage(
                sessionId,
                visitorIp,
                usageSettings.maxMessagesPerVisitor,
                resetPeriodMs
            )

            if (!visitorCheck.allowed) {
                send({
                    type: 'limit_reached',
                    error: AppConfig.errorMessages.visitorLimitReached,
                })
                return
            }
        }

        const existingCartId = isNewConversation
            ? null
            : await getCartId(conversationId)

        const mcpClient = new MCPClient(`https://${shop}`, {
            cartId: existingCartId,
        })

        await mcpClient.connectToStorefrontServer()

        const availableTools = [
            ...mcpClient.tools.filter((tool) => {
                if (!AppConfig.tools.enabledToolNames.includes(tool.name))
                    return false
                if (tool.name === 'create_cart' && existingCartId) return false
                return true
            }),
            ...LOCAL_TOOLS,
        ]

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
                    promptType,
                    customInstructions: safeCustomInstructions,
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
                            if (content.name === 'search_policies') {
                                const chunks = await searchPolicies(
                                    shop,
                                    content.input.query
                                )
                                toolUseResponse = {
                                    structuredContent: { chunks },
                                }
                            } else if (content.name === 'track_order') {
                                const accessToken = await getValidCustomerToken(
                                    shop,
                                    conversationId
                                )

                                if (!accessToken) {
                                    const authUrl = await startCustomerAuth(
                                        shop,
                                        conversationId
                                    )
                                    send({
                                        type: 'customer_auth_required',
                                        authUrl,
                                    })
                                    toolUseResponse = {
                                        structuredContent: {
                                            requiresLogin: true,
                                            message:
                                                "The customer needs to log in first to view their order. A login link has been shown to them — once they've logged in, ask them to try again.",
                                        },
                                    }
                                } else {
                                    // Logged in — actual order lookup
                                    // (MCP tool vs our own DB) is decided
                                    // later. For now just confirm
                                    // verification succeeded.
                                    toolUseResponse = {
                                        structuredContent: {
                                            verified: true,
                                            message:
                                                'The customer is verified and logged in. Let them know order lookup is being finalized.',
                                        },
                                    }
                                }
                            } else {
                                toolUseResponse = await mcpClient.callTool(
                                    content.name,
                                    content.input
                                )
                            }
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
                            logger.error(error)
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
        logger.error(error)
        send({
            type: 'error',
            error: AppConfig.errorMessages.genericError,
            details: error.message,
        })
    } finally {
        res.end()
    }
}
