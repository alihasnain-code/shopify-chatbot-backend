import {
    startCustomerAuth,
    completeCustomerAuth,
} from '../services/customer-account.server.js'
import { logger } from '../config/logger.js'

// POST /customer-auth/start   body: { shop, conversationId }
// Returns a URL the frontend opens (popup or redirect) to start login.
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

// GET /customer-auth/callback   query: { code, state, shop }
// Shopify redirects here after the customer logs in.
export async function callback(req, res) {
    const { code, state, shop } = req.query

    try {
        await completeCustomerAuth(shop, state, code)
        // Simple confirmation page that closes the popup — adjust to
        // match however your widget opens this (popup vs full redirect).
        res.send(`
            <html><body>
              <script>
                window.close();
              </script>
              <p>You're verified — you can close this window.</p>
            </body></html>
        `)
    } catch (error) {
        logger.error(error, 'Customer auth callback failed')
        res.status(400).send('Login failed. Please try again from the chat.')
    }
}

export default { start, callback }
