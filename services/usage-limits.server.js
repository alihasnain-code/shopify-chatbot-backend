import { prisma } from '../lib/prisma.js'

const RESET_PERIOD_MS = {
    hour: 60 * 60 * 1000,
    '6-hour': 6 * 60 * 60 * 1000,
    '12-hour': 12 * 60 * 60 * 1000,
    '24-hour': 24 * 60 * 60 * 1000,
    '7-day': 7 * 24 * 60 * 60 * 1000,
}

export function getResetPeriodMs(resetPeriod) {
    return RESET_PERIOD_MS[resetPeriod] ?? RESET_PERIOD_MS.hour
}

// Leftmost entry in X-Forwarded-For is the original client — everything
// after it is proxy hops (Shopify's app proxy, Cloudflare, etc.) appending
// as the request passes through. Falls back to the socket address only if
// the header is somehow absent (e.g. hitting the app directly, no proxy).
export function getVisitorIp(req) {
    const xff = req.headers['x-forwarded-for']
    if (xff) {
        const first = xff.split(',')[0].trim()
        if (first) return first
    }
    return req.socket.remoteAddress
}

// Rolling window, not a fixed clock boundary: resets exactly resetPeriodMs
// after THIS visitor's first message in their current window — matches
// "Reset period: 1 Hour" meaning "1 hour after you started", not "top of
// the hour" for everyone. Check + increment happen in one transaction so
// concurrent requests from the same visitor can't both slip through.
export async function checkAndIncrementVisitorUsage(
    sessionId,
    ip,
    maxMessages,
    resetPeriodMs
) {
    return prisma.$transaction(async (tx) => {
        const now = new Date()
        const existing = await tx.visitor_usage.findUnique({
            where: { sessionId_ip: { sessionId, ip } },
        })

        if (!existing) {
            await tx.visitor_usage.create({
                data: { sessionId, ip, windowStart: now, messageCount: 1 },
            })
            return { allowed: true }
        }

        const windowExpired =
            now.getTime() - existing.windowStart.getTime() >= resetPeriodMs

        if (windowExpired) {
            await tx.visitor_usage.update({
                where: { sessionId_ip: { sessionId, ip } },
                data: { windowStart: now, messageCount: 1 },
            })
            return { allowed: true }
        }

        if (existing.messageCount >= maxMessages) {
            return {
                allowed: false,
                resetAt: new Date(
                    existing.windowStart.getTime() + resetPeriodMs
                ),
            }
        }

        await tx.visitor_usage.update({
            where: { sessionId_ip: { sessionId, ip } },
            data: { messageCount: { increment: 1 } },
        })
        return { allowed: true }
    })
}

export default {
    getResetPeriodMs,
    getVisitorIp,
    checkAndIncrementVisitorUsage,
}
