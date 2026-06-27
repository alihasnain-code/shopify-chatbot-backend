import MCPClient from '../services/mcp-client.js'
import { createOpenAIService } from '../services/openai.server.js'
import { createToolService } from '../services/tool.server.js'
import AppConfig from '../services/config.server.js'

export default async function chatController(req, res) {
    const { shop, message } = req.body
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
    const mcpClient = new MCPClient(`https://${shop}`)

    try {
        await mcpClient.connectToStorefrontServer()

        let conversationHistory = [{ role: 'user', content: message }]
        let productsToDisplay = []
        let finalMessage = { stop_reason: null }

        while (finalMessage.stop_reason !== 'end_turn') {
            finalMessage = await openaiService.streamConversation(
                { messages: conversationHistory, tools: mcpClient.tools },
                {
                    onText: (chunk) => send({ type: 'chunk', chunk }),

                    onMessage: (msg) => {
                        conversationHistory.push({
                            role: msg.role,
                            content: msg.content,
                        })
                        send({ type: 'message_complete' })
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
                            await toolService.handleToolSuccess(
                                toolUseResponse,
                                content.name,
                                productsToDisplay
                            )
                        }

                        conversationHistory.push({
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: content.id,
                                    content: JSON.stringify(toolUseResponse),
                                },
                            ],
                        })

                        send({ type: 'new_message' })
                    },
                }
            )
        }

        send({ type: 'end_turn' })
        if (productsToDisplay.length > 0)
            send({ type: 'product_results', products: productsToDisplay })
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
