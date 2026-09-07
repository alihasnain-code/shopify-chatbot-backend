import { logger } from '../config/logger.js'

const tokenCache = new Map() // shop -> { value, expiresAt }

async function getAccessToken(shop) {
    const cached = tokenCache.get(shop)
    if (cached && cached.expiresAt > Date.now() + 5000) {
        return cached.value
    }

    const response = await fetch("https://api.shopify.com/auth/access_token", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            grant_type: 'client_credentials',
        }),
    })

    if (!response.ok) {
        throw new Error(`Failed to fetch access token: ${response.status}`)
    }

    const data = await response.json()

    const entry = {
        value: data.access_token,
        expiresAt:
            Date.now() +
            (data.expires_in ? data.expires_in * 1000 : 55 * 60 * 1000),
    }
    tokenCache.set(shop, entry)
    return entry.value
}

export async function searchShopPoliciesAndFaqs(shop, query, buyerIp) {
    const token = await getAccessToken(shop)

    const response = await fetch(`https://${shop}/api/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Shopify-Buyer-IP': buyerIp || '',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            id: 2,
            params: {
                name: 'search_shop_policies_and_faqs',
                arguments: { query },
            },
        }),
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Policy MCP request failed: ${response.status} ${text}`)
    }

    const data = await response.json()
    const raw = data.result?.content?.[0]?.text

    try {
        return raw ? JSON.parse(raw) : []
    } catch (err) {
        logger.error({ err, raw }, 'Failed to parse policy MCP response')
        return []
    }
}
