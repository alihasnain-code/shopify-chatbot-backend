import { logger } from '../config/logger.js'
import { verifyAndBuildOrder } from '../services/order-tracking.server.js'
import { appendMessage } from '../services/conversation-store.js'
import { randomUUID } from 'node:crypto'

const GENERIC_NOT_FOUND =
    "I couldn't find an order matching that information. Please double-check the order number and try again."

// POST /order-tracking/verify
// body: { shop, conversationId, orderNumber, contact }
export async function verify(req, res) {
    const { shop, conversationId, orderNumber, contact } = req.body

    if (!shop || !conversationId || !orderNumber || !contact) {
        return res.status(400).json({ error: 'Missing required fields' })
    }

    try {
        const result = await verifyAndBuildOrder(shop, orderNumber, contact)

        if (!result.found) {
            return res.json({ found: false, message: GENERIC_NOT_FOUND })
        }

        // Persist as a tool_use/tool_result pair — same pattern as
        // cart.controller.js's direct add-to-cart — so the AI has this
        // as context for later turns, and reloading the chat renders it
        // identically via getHistoryForClient().
        const toolUseId = `direct_${randomUUID()}`
        await appendMessage(conversationId, 'assistant', [
            {
                type: 'tool_use',
                id: toolUseId,
                name: 'track_order',
                input: { orderNumber },
            },
        ])
        await appendMessage(conversationId, 'user', [
            {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: JSON.stringify(result),
            },
        ])
        await appendMessage(conversationId, 'assistant', [
            {
                type: 'text',
                text: `Here's the status for order ${result.orderNumber}.`,
            },
        ])

        res.json({ found: true, data: result })
    } catch (error) {
        logger.error(error, 'Order verification failed')
        res.status(500).json({
            error: 'Something went wrong. Please try again.',
        })
    }
}

export default { verify }
