import {
    getHistoryForClient,
    getCartId,
} from '../services/conversation-store.js'

// GET /history?shop=...&conversationId=...
export default async function historyController(req, res) {
    const { conversationId } = req.query

    if (!conversationId) {
        return res.json({ conversationId: null, turns: [], cartId: null })
    }

    try {
        const [turns, cartId] = await Promise.all([
            getHistoryForClient(conversationId),
            getCartId(conversationId),
        ])

        res.json({ conversationId, turns, cartId })
    } catch (error) {
        res.status(500).json({ error: 'Failed to load conversation history' })
    }
}
