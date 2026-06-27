/**
 * Configuration Service
 * Centralizes all configuration values for the chat service
 */

export const AppConfig = {
    // API Configuration
    api: {
        defaultModel: process.env.MODEL_NAME,
        defaultPromptType: 'standardAssistant',
    },

    // Error Message Templates
    errorMessages: {
        missingMessage: 'Message is required',
        apiUnsupported:
            'This endpoint only supports server-sent events (SSE) requests or history requests.',
        rateLimitDetails: 'Please try again later',
        genericError: 'Failed to get response from AI',
    },

    // Tool Configuration
    tools: {
        productSearchName: 'search_catalog',
        maxProductsToDisplay: 3,
    },
}

export default AppConfig
