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
        conversationLimitReached:
            'This conversation has reached its message limit. Start a new conversation to keep chatting.',
        visitorLimitReached:
            'You have reached the maximum number of messages allowed for now. Please try again later.',
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
        // Enforced server-side in mcp-client.js — the model has no say in
        // this number regardless of what it puts in pagination.limit.
        searchCatalogLimit: 5,
    },
}

export default AppConfig
