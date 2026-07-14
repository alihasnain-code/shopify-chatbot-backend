// Minimal, hand-written schemas for the tools we enable — replaces the
// verbose schemas the MCP server returns (which include payment,
// attribution, fulfillment, discount fields etc. we don't use). This is a
// flat token cost paid on EVERY call regardless of conversation length, so
// trimming it helps more than history windowing does.

const searchCatalog = {
    type: 'object',
    properties: {
        catalog: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query string.',
                },
                // NOTE: no `limit` field here on purpose — the result
                // count is hard-enforced server-side in mcp-client.js
                // (AppConfig.tools.searchCatalogLimit), so it's not
                // something the model can request or vary.
                pagination: {
                    type: 'object',
                    properties: {
                        cursor: {
                            type: 'string',
                            description:
                                'Cursor from a previous search response, to fetch the next page.',
                        },
                    },
                },
            },
        },
    },
    required: ['catalog'],
}

const lookupCatalog = {
    type: 'object',
    properties: {
        catalog: {
            type: 'object',
            required: ['ids'],
            properties: {
                ids: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: 5,
                    description: 'Product or variant IDs to look up (max 5).',
                },
            },
        },
    },
    required: ['catalog'],
}

const getProduct = {
    type: 'object',
    properties: {
        catalog: {
            type: 'object',
            required: ['id'],
            properties: {
                id: { type: 'string', description: 'Product ID.' },
                selected: {
                    type: 'array',
                    description:
                        'Selected variant options, if narrowing a variant.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            label: { type: 'string' },
                        },
                    },
                },
            },
        },
    },
    required: ['catalog'],
}

// get_cart / cancel_cart need nothing from the model — the session's cart
// id is injected server-side.
const noParams = {
    type: 'object',
    properties: {},
}

const createCart = {
    type: 'object',
    properties: {
        cart: {
            type: 'object',
            required: ['line_items'],
            properties: {
                line_items: {
                    type: 'array',
                    description: 'Items to add to the new cart.',
                    items: {
                        type: 'object',
                        required: ['item', 'quantity'],
                        properties: {
                            item: {
                                type: 'object',
                                required: ['id'],
                                properties: {
                                    id: {
                                        type: 'string',
                                        description:
                                            'Product Variant ID to add.',
                                    },
                                },
                            },
                            quantity: { type: 'integer' },
                        },
                    },
                },
            },
        },
    },
    required: ['cart'],
}

const updateCart = {
    type: 'object',
    properties: {
        cart: {
            type: 'object',
            required: ['line_items'],
            properties: {
                line_items: {
                    type: 'array',
                    description:
                        "Items to add or update. Include an existing line item's 'id' to update/remove it (quantity 0 removes it); omit 'id' to add a new line.",
                    items: {
                        type: 'object',
                        required: ['item', 'quantity'],
                        properties: {
                            id: {
                                type: 'string',
                                description:
                                    'Existing line item ID, when updating or removing a line already in the cart. Omit when adding a new item.',
                            },
                            item: {
                                type: 'object',
                                required: ['id'],
                                properties: {
                                    id: {
                                        type: 'string',
                                        description: 'Product Variant ID.',
                                    },
                                },
                            },
                            quantity: {
                                type: 'integer',
                                description:
                                    'New quantity. Use 0 to remove the item.',
                            },
                        },
                    },
                },
            },
        },
    },
    required: ['cart'],
}

export const MINIMAL_TOOL_SCHEMAS = {
    search_catalog: searchCatalog,
    lookup_catalog: lookupCatalog,
    get_product: getProduct,
    get_cart: noParams,
    cancel_cart: noParams,
    create_cart: createCart,
    update_cart: updateCart,
}

export default MINIMAL_TOOL_SCHEMAS
