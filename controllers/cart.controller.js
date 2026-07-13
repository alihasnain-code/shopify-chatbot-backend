import { randomUUID } from 'node:crypto'
import MCPClient from '../services/mcp-client.js'
import { createToolService } from '../services/tool.server.js'
import {
    ensureConversation,
    appendMessage,
    getCartId,
    setCartId,
} from '../services/conversation-store.js'

// POST /cart/add
// body: { shop, conversationId?, variantId, quantity?, productTitle?, variantTitle? }
//
// Deliberately skips the LLM/openai loop — a button click already IS the
// intent, so we call create_cart/update_cart on the MCP client directly.
// The turn is still written to the DB in the exact same tool_use /
// tool_result / text shape the AI loop writes, so getHistoryForClient()
// renders it identically to an AI-driven add-to-cart on reload, with zero
// special-casing.
export default async function cartAddController(req, res) {
    const {
        shop,
        variantId,
        quantity = 1,
        productTitle,
        variantTitle,
    } = req.body
    let { conversationId } = req.body

    if (!shop || !variantId) {
        return res
            .status(400)
            .json({ error: 'shop and variantId are required' })
    }

    try {
        const isNewConversation = !conversationId
        if (isNewConversation) conversationId = randomUUID()
        await ensureConversation(conversationId, shop)

        const existingCartId = isNewConversation
            ? null
            : await getCartId(conversationId)

        const mcpClient = new MCPClient(`https://${shop}`, {
            cartId: existingCartId,
        })
        await mcpClient.connectToStorefrontServer()

        const toolName = existingCartId ? 'update_cart' : 'create_cart'
        const toolArgs = {
            cart: { line_items: [{ item: { id: variantId }, quantity }] },
        }

        const toolUseId = `direct_${randomUUID()}`
        const label = [productTitle, variantTitle].filter(Boolean).join(' — ')

        // Mirrors the shape chatController writes for a normal AI turn.
        await appendMessage(
            conversationId,
            'user',
            label ? `Add to cart: ${label}` : 'Add to cart'
        )
        await appendMessage(conversationId, 'assistant', [
            {
                type: 'tool_use',
                id: toolUseId,
                name: toolName,
                input: toolArgs,
            },
        ])

        const toolUseResponse = await mcpClient.callTool(toolName, toolArgs)

        if (toolUseResponse.error) {
            await appendMessage(conversationId, 'user', [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: JSON.stringify(toolUseResponse),
                },
            ])
            return res.status(502).json({
                conversationId,
                error: toolUseResponse.error.message || 'Failed to add to cart',
            })
        }

        if (mcpClient.cartId && mcpClient.cartId !== existingCartId) {
            await setCartId(conversationId, mcpClient.cartId)
        }

        const toolService = createToolService()
        const frontendResult = toolService.handleToolSuccess(
            toolUseResponse,
            toolName
        )
        const modelFacingResult = toolService.buildModelToolResult(
            toolUseResponse,
            toolName
        )

        await appendMessage(
            conversationId,
            'user',
            [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: JSON.stringify(modelFacingResult),
                },
            ],
            toolUseResponse.structuredContent // full payload for card rendering
        )
        await appendMessage(conversationId, 'assistant', [
            { type: 'text', text: 'Added to your cart.' },
        ])

        res.json({
            conversationId,
            tool: toolName,
            data: frontendResult?.data ?? toolUseResponse.structuredContent,
        })
    } catch (error) {
        res.status(500).json({ error: 'Failed to add item to cart' })
    }
}
