import AppConfig from './config.server.js'

const TONE_TO_PROMPT_TYPE = {
    standard: 'standardAssistant',
    enthusiastic: 'enthusiasticAssistant',
}

export function resolvePromptType(tone) {
    return TONE_TO_PROMPT_TYPE[tone] || AppConfig.api.defaultPromptType
}

export default { resolvePromptType }
