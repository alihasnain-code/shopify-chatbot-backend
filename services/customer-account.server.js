import crypto from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url')
}
function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url')
}
function generateState() {
    return crypto.randomBytes(16).toString('base64url')
}

const discoveryCache = new Map()

async function discoverOpenIdConfig(shop) {
    if (discoveryCache.has(shop)) return discoveryCache.get(shop)
    const res = await fetch(`https://${shop}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`OpenID discovery failed: ${res.status}`)
    const config = await res.json()
    discoveryCache.set(shop, config)
    return config
}

// Step 1: build the login URL for this specific conversation, and record
// the verifier/state so the callback can find its way back to the right
// chat conversation once Shopify redirects back.
export async function startCustomerAuth(shop, conversationId) {
    const openidConfig = await discoverOpenIdConfig(shop)

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    await prisma.code_verifier.create({
        data: { state, verifier: codeVerifier, shop, conversationId },
    })

    const authUrl = new URL(openidConfig.authorization_endpoint)
    authUrl.searchParams.set('client_id', process.env.SHOPIFY_API_KEY)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', process.env.CUSTOMER_AUTH_REDIRECT_URI)
    authUrl.searchParams.set('scope', 'openid email customer-account-api:full')
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')

    return authUrl.toString()
}

// Step 2: exchange the code, store the token against the same
// conversationId the state row was created with.
export async function completeCustomerAuth(state, code) {
    const verifierRow = await prisma.code_verifier.findUnique({ where: { state } })
    if (!verifierRow) throw new Error('Invalid or expired state parameter')

    const { shop, conversationId, verifier } = verifierRow
    const openidConfig = await discoverOpenIdConfig(shop)

    const tokenRes = await fetch(openidConfig.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: process.env.SHOPIFY_API_KEY,
            redirect_uri: process.env.CUSTOMER_AUTH_REDIRECT_URI,
            code,
            code_verifier: verifier,
        }),
    })

    if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        logger.error({ status: tokenRes.status, errText }, 'Customer token exchange failed')
        throw new Error('Token exchange failed')
    }

    const tokenData = await tokenRes.json()
    const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null

    await prisma.customer_access_token.create({
        data: { shop, conversationId, accessToken: tokenData.access_token, expiresAt },
    })

    await prisma.code_verifier.delete({ where: { state } }).catch(() => { })

    return conversationId
}

// Used by chat.controller.js to check whether this conversation is
// already logged in before triggering a new auth link.
export async function getValidCustomerToken(shop, conversationId) {
    const row = await prisma.customer_access_token.findFirst({
        where: {
            shop,
            conversationId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: 'desc' },
    })
    return row?.accessToken ?? null
}

export default { startCustomerAuth, completeCustomerAuth, getValidCustomerToken }