import {
    startCustomerAuth,
    completeCustomerAuth,
} from '../services/customer-account.server.js'
import { logger } from '../config/logger.js'

// POST /customer-auth/start   body: { shop, conversationId }
export async function start(req, res) {
    const { shop, conversationId } = req.body
    if (!shop || !conversationId) {
        return res
            .status(400)
            .json({ error: 'shop and conversationId are required' })
    }

    try {
        const authUrl = await startCustomerAuth(shop, conversationId)
        res.json({ authUrl })
    } catch (error) {
        logger.error(error, 'Failed to start customer auth')
        res.status(500).json({ error: 'Failed to start login' })
    }
}

// GET /customer-auth/callback   query: { code, state }
// Same popup + postMessage handshake as your tested widget: this page
// only ever runs inside the popup window, so it messages the opener and
// closes itself — no visible UI needed.
export async function callback(req, res) {
    const { code, state } = req.query

    const respond = (payload) => {
        res.set('Content-Type', 'text/html')
        res.send(`<script>
            window.opener && window.opener.postMessage(${JSON.stringify(payload)}, "*");
            window.close();
        </script>`)
    }

    if (!code || !state) {
        return respond({ ok: false, error: 'Missing code or state' })
    }

    try {
        await completeCustomerAuth(state, code)
        respond({ ok: true })
    } catch (error) {
        logger.error(error, 'Customer auth callback failed')
        respond({ ok: false, error: error.message })
    }
}

export default { start, callback }
