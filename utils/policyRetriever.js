import { prisma } from '../lib/prisma.js'

/**
 * Cosine similarity between two equal-length numeric vectors.
 */
function cosineSimilarity(a, b) {
    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Finds the most relevant policy chunks for a given query embedding.
 * Since MySQL has no native vector search, similarity is computed
 * in-memory. This is fine at this scale — a shop's total policy
 * chunks number in the dozens, not millions.
 *
 * @param {string} shop - shop domain
 * @param {number[]} queryVector - embedding of the user's question
 * @param {object} options
 * @param {string} [options.policyType] - restrict search to one policy type
 * @param {number} [options.topK] - number of chunks to return
 */
export async function findRelevantPolicyChunks(
    shop,
    queryVector,
    { policyType, topK = 4 } = {}
) {
    const rows = await prisma.policy_chunks.findMany({
        where: {
            shop_domain: shop,
            ...(policyType ? { policy_type: policyType } : {}),
        },
        select: {
            text_chunk: true,
            policy_type: true,
            embedding: true,
        },
    })

    const scored = rows.map((row) => ({
        text: row.text_chunk,
        policyType: row.policy_type,
        // embedding is stored as a JSON string (LongText column), so parse it back into an array
        score: cosineSimilarity(queryVector, JSON.parse(row.embedding)),
    }))

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, topK)
}
