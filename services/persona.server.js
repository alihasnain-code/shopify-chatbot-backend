import AppConfig from './config.server.js'

const TONE_TO_PROMPT_TYPE = {
    standard: 'standardAssistant',
    enthusiastic: 'enthusiasticAssistant',
}

export function resolvePromptType(tone) {
    return TONE_TO_PROMPT_TYPE[tone] || AppConfig.api.defaultPromptType
}

// Length is already enforced at write time (Zod schema on the save
// endpoint). This only guards against the text breaking out of the
// system prompt's structure or trying to pass itself off as a new
// instruction/role.
export function sanitizeCustomInstructions(raw) {
    if (!raw || typeof raw !== 'string') return null

    const cleaned = raw
        .replace(/```/g, "'''") // no breaking out via code fences
        .replace(/<\/?merchant_store_info>/gi, '') // no closing our tag early
        .replace(/^\s*(system|assistant|developer)\s*:/gim, '') // fake role headers
        .trim()

    return cleaned || null
}

export default { resolvePromptType, sanitizeCustomInstructions }
