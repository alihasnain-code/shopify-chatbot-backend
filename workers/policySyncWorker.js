import { Worker } from 'bullmq'
import { Session } from '@shopify/shopify-api'
import redis from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import shopify from '../lib/shopify.server.js'
import { cleanPolicyText } from '../utils/policyCleaner.js'
import { chunkAndEmbedPolicy } from '../utils/policyEmbedder.js'

const POLICIES_QUERY = `
  query getAdminPolicies {
    shop {
      shopPolicies {
        type
        body
      }
    }
  }
`

/**
 * Upserts the sync status/timestamp on user_configs for a given session.
 * Used for both the initial (afterAuth) sync and manual "Sync Policies Now"
 * runs, since both dispatch into this same worker/queue.
 */
async function setPolicySyncStatus(sessionId, status, { lastSyncedAt } = {}) {
    try {
        await prisma.user_configs.upsert({
            where: { sessionId },
            create: {
                sessionId,
                policiesStatus: status,
                ...(lastSyncedAt ? { lastSyncedAt } : {}),
            },
            update: {
                policiesStatus: status,
                ...(lastSyncedAt ? { lastSyncedAt } : {}),
            },
        })
    } catch (statusError) {
        // Don't let a status-tracking failure mask/replace the real sync error
        console.error(
            `[Worker] Failed to update policiesStatus (${status}) for session ${sessionId}:`,
            statusError
        )
    }
}

export const policySyncWorker = new Worker(
    'policy-sync',
    async (job) => {
        const { shop } = job.data
        console.log(
            `[Worker] Processing policy sync execution for store: ${shop}`
        )

        // Tracked once we've confirmed a valid session record exists below,
        // so the catch block can flip status to FAILED even on early errors.
        let syncedSessionId = null

        try {
            // 1. Get authenticated GraphQL access offline
            //    NOTE: raw @shopify/shopify-api has no `sessionStorage` or
            //    `unauthenticated` helper — those only exist on the
            //    shopify-app-express/remix wrapper objects. With the raw
            //    library you look up the offline session id yourself and
            //    build the client manually.
            const offlineSessionId = shopify.session.getOfflineId(shop)
            const sessionRecord = await prisma.session.findUnique({
                where: { id: offlineSessionId },
            })

            if (!sessionRecord)
                throw new Error(
                    `Could not locate active authentication token context for ${shop}`
                )

            syncedSessionId = sessionRecord.id

            // Mark this run as in-progress now that we know the session (and
            // therefore the user_configs FK target) is valid. This covers both
            // the first-time afterAuth sync and any manual "Sync Policies Now"
            // run — they're the same job type on the same queue, so whichever
            // triggered this run gets the same status tracking.
            await setPolicySyncStatus(syncedSessionId, 'IN_PROGRESS')

            // Rehydrate a Session instance from your stored row so the
            // Graphql client has what it needs (shop + accessToken).
            const session = new Session({
                id: sessionRecord.id,
                shop: sessionRecord.shop,
                state: sessionRecord.state,
                isOnline: sessionRecord.isOnline,
                accessToken: sessionRecord.accessToken,
            })

            const client = new shopify.clients.Graphql({ session })
            const result = await client.request(POLICIES_QUERY)
            // NOTE: client.request() resolves to { data, extensions } directly —
            // no .json() needed here, unlike admin.graphql() in the wrapper packages

            const policies = result?.data?.shop?.shopPolicies || []
            if (!policies.length) {
                console.log(
                    `[Worker] No shop policies configured to process for: ${shop}`
                )
                await setPolicySyncStatus(syncedSessionId, 'SYNCED', {
                    lastSyncedAt: new Date(),
                })
                return
            }

            // 2. Loop through and execute transactional document updates
            for (const policy of policies) {
                if (!policy.body) continue

                const cleanText = cleanPolicyText(policy.body)
                const embeddedChunks = await chunkAndEmbedPolicy(
                    cleanText,
                    policy.type
                )

                // 3. Purge existing chunk rows to prepare for fresh replacement rows
                await prisma.policy_chunks.deleteMany({
                    where: {
                        shop_domain: shop,
                        policy_type: policy.type,
                    },
                })

                // 4. Batch insert chunks with embeddings stored as a JSON string
                //    (embedding is a LongText column, not a native Json type,
                //    so we stringify it ourselves — see policyRetriever.js
                //    for the matching JSON.parse on read)
                if (embeddedChunks.length > 0) {
                    await prisma.policy_chunks.createMany({
                        data: embeddedChunks.map((chunk) => ({
                            shop_domain: shop,
                            policy_type: chunk.policyType,
                            text_chunk: chunk.text,
                            embedding: JSON.stringify(chunk.vector),
                        })),
                    })
                }
            }

            console.log(
                `[Worker] Successfully completed vectors refresh processing for ${shop}`
            )

            await setPolicySyncStatus(syncedSessionId, 'SYNCED', {
                lastSyncedAt: new Date(),
            })
        } catch (error) {
            console.error(
                `[Worker Execution Failure] Failed to process job ${job.id}:`,
                error
            )

            // Only flip to FAILED if we got far enough to resolve a session —
            // otherwise there's no valid user_configs FK target to update.
            if (syncedSessionId) {
                await setPolicySyncStatus(syncedSessionId, 'FAILED')
            }

            throw error // Let BullMQ capture the fail context rules and handle retries
        }
    },
    {
        connection: redis,
        concurrency: 3, // Safely handle multiple parallel jobs processing concurrently without spiking CPU
    }
)
