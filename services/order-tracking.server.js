import { prisma } from '../lib/prisma.js'
import { logger } from '../config/logger.js'

function extractEmail(payload) {
    if (payload.contact_email)
        return { value: payload.contact_email, source: 'root' }
    if (payload.email) return { value: payload.email, source: 'root' }
    if (payload.customer?.email)
        return { value: payload.customer.email, source: 'customer' }
    return { value: null, source: null }
}

function extractPhone(payload) {
    if (payload.phone) return { value: payload.phone, source: 'root' }
    if (payload.customer?.phone)
        return { value: payload.customer.phone, source: 'customer' }
    if (payload.shipping_address?.phone)
        return {
            value: payload.shipping_address.phone,
            source: 'shipping_address',
        }
    if (payload.billing_address?.phone)
        return {
            value: payload.billing_address.phone,
            source: 'billing_address',
        }
    return { value: null, source: null }
}

function extractAddress(address) {
    if (!address) return { city: null, province: null, country: null }
    return {
        city: address.city ?? null,
        province: address.province ?? null,
        country: address.country ?? null,
    }
}

function extractLineItems(lineItems = []) {
    return lineItems.map((li) => ({
        title: li.title,
        variantTitle: li.variant_title || null,
        quantity: li.quantity,
    }))
}

// ---------- Shopify GraphQL helpers ----------
async function getAccessTokenForShop(shop) {
    const session = await prisma.session.findFirst({
        where: { shop },
        select: { accessToken: true },
    })
    if (!session) {
        throw new Error(`No offline session found for shop ${shop}`)
    }
    return session.accessToken
}

async function fetchShopifyGraphQL(shop, query, variables = {}) {
    const token = await getAccessTokenForShop(shop)
    const response = await fetch(
        `https://${shop}/admin/api/2026-10/graphql.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify({ query, variables }),
        }
    )
    if (!response.ok) {
        const text = await response.text()
        throw new Error(
            `Shopify GraphQL request failed: ${response.status} ${text}`
        )
    }
    const json = await response.json()
    if (json.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
    }
    return json.data
}

async function getVerificationField(shop) {
    const session = await prisma.session.findFirst({
        where: { shop, isOnline: false },
        select: { id: true },
    })
    if (!session) return 'email'
    const settings = await prisma.usagesettings.findUnique({
        where: { sessionId: session.id },
        select: { verificationMethod: true },
    })
    return settings?.verificationMethod === 'phone' ? 'phone' : 'email'
}

function normalizeOrderNumber(input) {
    const digits = String(input || '').replace(/[^\d]/g, '')
    return digits ? parseInt(digits, 10) : null
}

function normalizePhone(phone) {
    if (!phone) return null
    return phone.replace(/\D/g, '').slice(-10)
}

// Keys must match Shopify's FulfillmentDisplayStatus enum values exactly
// (Fulfillment.displayStatus) — these come back UPPER_SNAKE_CASE, not the
// lowercase REST-style strings the old webhook payloads used.
const STATUS_LABELS = {
    SUBMITTED: 'Preparing to ship',
    CONFIRMED: 'Preparing to ship',
    LABEL_PURCHASED: 'Preparing to ship',
    LABEL_PRINTED: 'Preparing to ship',
    CARRIER_PICKED_UP: 'Picked up by carrier',
    IN_TRANSIT: 'In transit',
    OUT_FOR_DELIVERY: 'Out for delivery',
    READY_FOR_PICKUP: 'Ready for pickup',
    PICKED_UP: 'Picked up',
    DELIVERED: 'Delivered',
    ATTEMPTED_DELIVERY: 'Delivery attempted',
    DELAYED: 'Delayed',
    FAILURE: "Delivery issue — we're looking into it",
    NOT_DELIVERED: "Delivery issue — we're looking into it",
    FULFILLED: 'Shipped',
    MARKED_AS_FULFILLED: 'Shipped',
    CANCELED: 'Cancelled',
    LABEL_VOIDED: 'Cancelled',
}

async function verifyAndBuildOrder(shop, orderNumberInput, contactValue) {
    const orderNumber = normalizeOrderNumber(orderNumberInput)
    if (!orderNumber) return { found: false }

    // 1. Fetch order from Shopify using GraphQL
    // The order_number filter value is bound through the $searchQuery
    // variable (not spliced into the query document text) — this is both
    // safer and required, since GraphQL rejects a declared variable that
    // the query body never references.
    const query = `
    query getOrder($searchQuery: String!) {
      orders(first: 1, query: $searchQuery) {
        edges {
          node {
            id
            orderNumber
            name
            email
            phone
            displayFinancialStatus
            displayFulfillmentStatus
            currency
            currentTotalPrice
            cancelledAt
            cancelReason
            createdAt
            shippingAddress {
              city
              province
              country
            }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                }
              }
            }
            fulfillments(first: 10) {
              edges {
                node {
                  displayStatus
                  trackingCompany
                  trackingNumber
                  trackingUrl
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      }
    }
  `

    let data
    try {
        data = await fetchShopifyGraphQL(shop, query, {
            searchQuery: `order_number:${orderNumber}`,
        })
    } catch (err) {
        logger.error(
            { err, shop, orderNumber },
            'Failed to fetch order from Shopify'
        )
        return { found: false }
    }

    const orderEdge = data?.orders?.edges?.[0]
    if (!orderEdge) {
        return { found: false }
    }

    const node = orderEdge.node

    // 2. Build a payload that resembles the REST webhook structure so we can reuse extractors
    const payload = {
        email: node.email,
        phone: node.phone,
        shipping_address: {
            city: node.shippingAddress?.city,
            province: node.shippingAddress?.province,
            country: node.shippingAddress?.country,
        },
        line_items: node.lineItems.edges.map((edge) => ({
            title: edge.node.title,
            variant_title: edge.node.variantTitle,
            quantity: edge.node.quantity,
        })),
        financial_status: node.displayFinancialStatus,
        fulfillment_status: node.displayFulfillmentStatus,
        currency: node.currency,
        total_price: node.currentTotalPrice,
        cancelled_at: node.cancelledAt,
        cancel_reason: node.cancelReason,
        created_at: node.createdAt,
    }

    // 3. Verify contact match
    const field = await getVerificationField(shop)
    let isMatch = false
    if (field === 'phone') {
        const orderPhone = extractPhone(payload).value
        isMatch =
            orderPhone &&
            normalizePhone(orderPhone) === normalizePhone(contactValue)
    } else {
        const orderEmail = extractEmail(payload).value
        isMatch =
            orderEmail &&
            orderEmail.trim().toLowerCase() ===
                String(contactValue).trim().toLowerCase()
    }
    if (!isMatch) {
        return { found: false }
    }

    // 4. Build the response object
    const lineItems = extractLineItems(payload.line_items)
    const fulfillments =
        node.fulfillments?.edges?.map((edge) => edge.node) || []

    if (payload.cancelled_at) {
        return {
            found: true,
            orderNumber: node.name,
            status: 'Cancelled',
        }
    }

    if (fulfillments.length === 0) {
        return {
            found: true,
            orderNumber: node.name,
            status: 'Processing',
            items: lineItems.map((li) => `${li.title} x${li.quantity}`),
        }
    }

    return {
        found: true,
        orderNumber: node.name,
        items: lineItems.map((li) => `${li.title} x${li.quantity}`),
        shipments: fulfillments.map((f) => ({
            status: STATUS_LABELS[f.displayStatus] || 'Processing',
            carrier: f.trackingCompany || null,
            trackingNumber: f.trackingNumber || null,
            trackingUrl: f.trackingUrl || null,
        })),
    }
}

export { getVerificationField, verifyAndBuildOrder }

export default {
    getVerificationField,
    verifyAndBuildOrder,
}
