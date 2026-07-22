import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'
import {
    generateCodeVerifier,
    generateCodeChallenge,
    generateState,
} from './pkce.server.js'

// Discovery responses are static per shop for a long time — cache in
// memory to avoid a round trip on every auth attempt. Not persisted; a
// server restart just re-fetches once.
const discoveryCache = new Map()

async function discoverOAuthConfig(shopDomain) {
    if (discoveryCache.has(shopDomain)) return discoveryCache.get(shopDomain)

    const res = await fetch(
        `https://${shopDomain}/.well-known/openid-configuration`
    )
    if (!res.ok) throw new Error(`OAuth discovery failed: ${res.status}`)
    const config = await res.json()
    discoveryCache.set(shopDomain, config)
    return config
}

async function discoverMcpEndpoint(shopDomain) {
    const key = `mcp:${shopDomain}`
    if (discoveryCache.has(key)) return discoveryCache.get(key)

    const res = await fetch(
        `https://${shopDomain}/.well-known/customer-account-api`
    )
    if (!res.ok)
        throw new Error(`Customer account API discovery failed: ${res.status}`)
    const config = await res.json()
    discoveryCache.set(key, config)
    return config // { mcp_api, graphql_api, ... }
}

// Step 1 + 2: build the URL the customer needs to be sent to. Persists
// state + code_verifier keyed by conversationId so the callback can find
// them again — this stands in for what a browser session would normally
// hold, since your chat widget is a guest session, not a logged-in one.
export async function startCustomerAuth(shop, conversationId) {
    const oauthConfig = await discoverOAuthConfig(shop)

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    await prisma.customer_account_auth.create({
        data: { conversationId, shop, state, codeVerifier },
    })

    const params = new URLSearchParams({
        client_id: process.env.SHOPIFY_API_KEY,
        redirect_uri: process.env.CUSTOMER_AUTH_REDIRECT_URI,
        response_type: 'code',
        scope: 'customer-account-mcp-api:full',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    })

    return `${oauthConfig.authorization_endpoint}?${params}`
}

// Step 3: exchange the authorization code for an access token.
export async function completeCustomerAuth(shop, state, code) {
    const authRow = await prisma.customer_account_auth.findUnique({
        where: { state },
    })
    if (!authRow || authRow.shop !== shop) {
        throw new Error('Invalid or expired auth state')
    }

    const oauthConfig = await discoverOAuthConfig(shop)

    const tokenRes = await fetch(oauthConfig.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: process.env.SHOPIFY_API_KEY,
            redirect_uri: process.env.CUSTOMER_AUTH_REDIRECT_URI,
            code,
            code_verifier: authRow.codeVerifier,
        }),
    })

    if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        logger.error(
            { status: tokenRes.status, errText },
            'Customer account token exchange failed'
        )
        throw new Error('Token exchange failed')
    }

    const tokenData = await tokenRes.json()
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)

    await prisma.customer_account_auth.update({
        where: { state },
        data: {
            accessToken: tokenData.access_token,
            tokenExpiresAt: expiresAt,
        },
    })

    return authRow.conversationId
}

// Looks up a still-valid token for this conversation, if one exists.
export async function getValidCustomerToken(shop, conversationId) {
    const row = await prisma.customer_account_auth.findFirst({
        where: {
            shop,
            conversationId,
            accessToken: { not: null },
            tokenExpiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
    })
    return row?.accessToken ?? null
}

// Step 4: authenticated MCP call.
export async function callCustomerAccountMcp(
    shop,
    accessToken,
    toolName,
    toolArgs
) {
    const { mcp_api } = await discoverMcpEndpoint(shop)

    const res = await fetch(mcp_api, {
        method: 'POST',
        headers: {
            Authorization: accessToken,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: toolName, arguments: toolArgs },
        }),
    })

    if (res.status === 401) {
        // Token expired/invalid mid-conversation — caller should restart
        // the auth flow.
        const err = new Error('Customer account token unauthorized')
        err.status = 401
        throw err
    }

    if (!res.ok) {
        throw new Error(`Customer account MCP call failed: ${res.status}`)
    }

    const data = await res.json()
    return data.result || data
}

export default {
    startCustomerAuth,
    completeCustomerAuth,
    getValidCustomerToken,
    callCustomerAccountMcp,
}
