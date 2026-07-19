import { embedQuery } from "../utils/policyEmbedder.js"
import { findRelevantPolicyChunks } from "../utils/policyRetriever.js"

export async function searchPolicies(shop, query) {
    const queryVector = await embedQuery(query)
    const chunks = await findRelevantPolicyChunks(shop, queryVector, { topK: 4 })
    return chunks // [{ text, policyType, score }]
}