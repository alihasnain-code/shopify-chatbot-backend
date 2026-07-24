import { prisma } from '../lib/prisma.js'

// Every webhook needs the offline session id to satisfy the sessionId FK —
// same lookup pattern used in form.controller.js / questions.controller.js.
async function getSessionIdForShop(shop) {
    const session = await prisma.session.findFirst({
        where: { shop, isOnline: false },
        select: { id: true },
    })
    return session?.id ?? null
}

// Root fields first (contact_email/email is what the buyer actually typed
// at checkout for THIS order), customer.email as a fallback only — the
// customer object reflects their CURRENT profile, which can drift from
// what was true when this specific order was placed.
function extractEmail(payload) {
    if (payload.contact_email)
        return { value: payload.contact_email, source: 'root' }
    if (payload.email) return { value: payload.email, source: 'root' }
    if (payload.customer?.email)
        return { value: payload.customer.email, source: 'customer' }
    return { value: null, source: null }
}

// Same priority logic for phone — root contact phone first, since that's
// what was entered for this order specifically. shipping/billing address
// phone is last resort (could belong to a gift recipient, not the buyer).
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

// Only the fields the tracking bot ever needs — no full address, no
// customer object, no payment/discount internals.
function extractLineItems(lineItems = []) {
    return lineItems.map((li) => ({
        title: li.title,
        variantTitle: li.variant_title || null,
        quantity: li.quantity,
    }))
}

// City/province/country only — never street address, even though the
// webhook payload includes it.
function extractAddress(address) {
    if (!address) return { city: null, province: null, country: null }
    return {
        city: address.city ?? null,
        province: address.province ?? null,
        country: address.country ?? null,
    }
}

// Used by orders/create, orders/updated, and orders/cancelled — all three
// deliver the same full Order resource shape, so one upsert handles all of
// them. orders/cancelled just happens to arrive with cancelled_at set.
export async function upsertOrderFromWebhook(shop, payload) {
    const sessionId = await getSessionIdForShop(shop)
    if (!sessionId) {
        // No installed offline session for this shop yet — nothing to link
        // the row to. Log and bail rather than crash the webhook (Shopify
        // will retry, but a missing session means retries won't help
        // anyway, so we just skip silently here).
        console.error(
            `No offline session found for shop ${shop}, skipping order webhook`
        )
        return
    }

    const { city, province, country } = extractAddress(payload.shipping_address)

    // Both are always extracted and stored, tagged with where each came
    // from. Which one is USED for verification is decided later, at
    // lookup time, based on the shop's current verificationMethod setting
    // — so switching that setting never requires re-extracting anything.
    const email = extractEmail(payload)
    const phone = extractPhone(payload)

    await prisma.order.upsert({
        where: { shopifyOrderId: String(payload.id) },
        create: {
            sessionId,
            shopifyOrderId: String(payload.id),
            orderNumber: payload.order_number,
            orderName: payload.name,
            email: email.value,
            emailSource: email.source,
            phone: phone.value,
            phoneSource: phone.source,
            financialStatus: payload.financial_status || null,
            fulfillmentStatus: payload.fulfillment_status || null,
            currency: payload.currency || null,
            totalPrice:
                payload.current_total_price || payload.total_price || null,
            lineItems: JSON.stringify(extractLineItems(payload.line_items)),
            shippingCity: city,
            shippingProvince: province,
            shippingCountry: country,
            cancelledAt: payload.cancelled_at
                ? new Date(payload.cancelled_at)
                : null,
            cancelReason: payload.cancel_reason || null,
            shopifyCreatedAt: new Date(payload.created_at),
        },
        update: {
            email: email.value,
            emailSource: email.source,
            phone: phone.value,
            phoneSource: phone.source,
            financialStatus: payload.financial_status || null,
            fulfillmentStatus: payload.fulfillment_status || null,
            totalPrice:
                payload.current_total_price || payload.total_price || null,
            lineItems: JSON.stringify(extractLineItems(payload.line_items)),
            cancelledAt: payload.cancelled_at
                ? new Date(payload.cancelled_at)
                : null,
            cancelReason: payload.cancel_reason || null,
        },
    })
}

// Used by fulfillments/create and fulfillments/update — same Fulfillment
// resource shape for both.
export async function upsertFulfillmentFromWebhook(payload) {
    const order = await prisma.order.findUnique({
        where: { shopifyOrderId: String(payload.order_id) },
        select: { id: true },
    })

    if (!order) {
        // Fulfillment webhook arrived before the order webhook was
        // processed (race condition — Shopify doesn't guarantee delivery
        // order). Log and bail; the next fulfillments/update for the same
        // fulfillment will retry the link once the order row exists.
        console.error(
            `No local order found for shopifyOrderId ${payload.order_id}, skipping fulfillment webhook`
        )
        return
    }

    const trackingUrl =
        payload.tracking_url || payload.tracking_urls?.[0] || null

    await prisma.order_fulfillment.upsert({
        where: { shopifyFulfillmentId: String(payload.id) },
        create: {
            shopifyFulfillmentId: String(payload.id),
            orderId: order.id,
            status: payload.status || null,
            shipmentStatus: payload.shipment_status || null,
            trackingCompany: payload.tracking_company || null,
            trackingNumber: payload.tracking_number || null,
            trackingUrl,
            shopifyCreatedAt: new Date(payload.created_at),
            shopifyUpdatedAt: new Date(payload.updated_at),
        },
        update: {
            status: payload.status || null,
            shipmentStatus: payload.shipment_status || null,
            trackingCompany: payload.tracking_company || null,
            trackingNumber: payload.tracking_number || null,
            trackingUrl,
            shopifyUpdatedAt: new Date(payload.updated_at),
        },
    })
}

async function getVerificationField(shop) {
    const sessionId = await getSessionIdForShop(shop)
    if (!sessionId) return 'email'
    const settings = await prisma.usagesettings.findUnique({
        where: { sessionId },
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

const STATUS_LABELS = {
    fulfilled: 'Shipped',
    partial: 'Partially shipped',
    label_printed: 'Preparing to ship',
    in_transit: 'In transit',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    failure: "Delivery issue — we're looking into it",
}

// Matches order number + the submitted contact value (per shop's
// verificationMethod) against stored order rows. Same generic outcome
// whether the order doesn't exist or the contact doesn't match — never
// reveals which one failed.
async function verifyAndBuildOrder(shop, orderNumberInput, contactValue) {
    const orderNumber = normalizeOrderNumber(orderNumberInput)
    if (!orderNumber) return { found: false }

    const order = await prisma.order.findFirst({
        where: {
            orderNumber,
            session: { shop, isOnline: false },
        },
        include: { fulfillments: true },
    })
    if (!order) return { found: false }

    const field = await getVerificationField(shop)

    const isMatch =
        field === 'phone'
            ? order.phone &&
            normalizePhone(order.phone) === normalizePhone(contactValue)
            : order.email &&
            order.email.trim().toLowerCase() ===
            String(contactValue).trim().toLowerCase()

    if (!isMatch) return { found: false }

    const lineItems = JSON.parse(order.lineItems || '[]')

    if (order.cancelledAt) {
        return {
            found: true,
            orderNumber: order.orderName,
            status: 'Cancelled',
        }
    }

    if (!order.fulfillments.length) {
        return {
            found: true,
            orderNumber: order.orderName,
            status: 'Processing',
            items: lineItems.map((li) => `${li.title} x${li.quantity}`),
        }
    }

    return {
        found: true,
        orderNumber: order.orderName,
        items: lineItems.map((li) => `${li.title} x${li.quantity}`),
        shipments: order.fulfillments.map((f) => ({
            status:
                STATUS_LABELS[f.shipmentStatus] ||
                STATUS_LABELS[f.status] ||
                'Processing',
            carrier: f.trackingCompany || null,
            trackingNumber: f.trackingNumber || null,
            trackingUrl: f.trackingUrl || null,
        })),
    }
}

export { getVerificationField, verifyAndBuildOrder }

export default {
    upsertOrderFromWebhook,
    upsertFulfillmentFromWebhook,
    getVerificationField,
    verifyAndBuildOrder,
}
