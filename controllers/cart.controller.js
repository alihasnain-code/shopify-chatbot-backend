import { randomUUID } from 'node:crypto'
import { logger } from '../config/logger.js'
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
// Skips the LLM entirely — the button click already IS the intent. Writes
// the exact same tool_use / tool_result / text row shapes chatController
// writes, so getHistoryForClient() renders it identically on reload with
// no special-casing.
//
// Two layers of protection against orphaned tool_call_ids (which would
// otherwise permanently break future /chat calls for this conversation):
//   1. mcpClient.callTool is wrapped so ANY failure still produces a
//      tool_result (as an error payload) before responding.
//   2. An outer catch-all writes a fallback tool_result if something
//      unexpected still slips through after the tool_use row was written.
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

    let toolUseId = null
    let conversationReady = false

    try {
        const isNewConversation = !conversationId
        if (isNewConversation) conversationId = randomUUID()
        await ensureConversation(conversationId, shop)
        conversationReady = true

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

        toolUseId = `direct_${randomUUID()}`
        const label = [productTitle, variantTitle].filter(Boolean).join(' — ')

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

        let toolUseResponse
        try {
            toolUseResponse = await mcpClient.callTool(toolName, toolArgs)
        } catch (err) {
            toolUseResponse = {
                error: { message: err.message || 'Tool call failed' },
            }
        }

        if (toolUseResponse.error) {
            await appendMessage(conversationId, 'user', [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: JSON.stringify(toolUseResponse),
                },
            ])
            await appendMessage(conversationId, 'assistant', [
                {
                    type: 'text',
                    text: "I couldn't add that to your cart just now.",
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

        // Full payload persisted — identical to what /chat would have stored.
        await appendMessage(conversationId, 'user', [
            {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: JSON.stringify(toolUseResponse.structuredContent),
            },
        ])
        await appendMessage(conversationId, 'assistant', [
            { type: 'text', text: 'Added to your cart.' },
        ])

        const toolService = createToolService()
        const frontendResult = toolService.handleToolSuccess(
            toolUseResponse,
            toolName
        )

        res.json({
            conversationId,
            tool: toolName,
            data: frontendResult?.data ?? toolUseResponse.structuredContent,
        })
    } catch (error) {
        logger.error(error)
        // Outer safety net: if a tool_use row was written but we crashed
        // before its tool_result, close the pairing now.
        if (conversationReady && toolUseId) {
            await appendMessage(conversationId, 'user', [
                {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: JSON.stringify({
                        error: { message: 'Add to cart failed unexpectedly.' },
                    }),
                },
            ]).catch(() => {})
        }
        res.status(500).json({ error: 'Failed to add item to cart' })
    }
}
