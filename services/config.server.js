export const AppConfig = {
    api: {
        defaultModel: process.env.MODEL_NAME,
        defaultPromptType: 'standardAssistant',
        maxRecentMessages: 16,
    },

    errorMessages: {
        missingMessage: 'Message is required',
        apiUnsupported:
            'This endpoint only supports server-sent events (SSE) requests or history requests.',
        rateLimitDetails: 'Please try again later',
        genericError: 'Failed to get response from AI',
    },

    tools: {
        enabledToolNames: [
            'search_catalog',
            'get_product',
            'lookup_catalog',
            'get_cart',
            'create_cart',
            'update_cart',
            'cancel_cart',
        ],
        cartToolsRequiringId: ['get_cart', 'update_cart', 'cancel_cart'],
        cartToolNames: [
            'get_cart',
            'create_cart',
            'update_cart',
            'cancel_cart',
        ],
    },
}

export default AppConfig
