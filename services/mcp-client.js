import { logger } from '../config/logger.js'
import AppConfig from './config.server.js'
import { MINIMAL_TOOL_SCHEMAS } from './tool-schemas.js'

const DEFAULT_UCP_AGENT_META = {
    'ucp-agent': {
        profile:
            process.env.UCP_AGENT_PROFILE_URL ||
            'https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json',
    },
}

class MCPClient {
    constructor(hostUrl, { cartId = null } = {}) {
        this.tools = []
        this.storefrontTools = []
        this.storefrontMcpEndpoint = `${hostUrl}/api/ucp/mcp`
        this.cartId = cartId
    }

    async connectToStorefrontServer() {
        try {
            logger.info(
                { endpoint: this.storefrontMcpEndpoint },
                'Connecting to MCP server'
            )

            const headers = { 'Content-Type': 'application/json' }
            const params = { arguments: { meta: DEFAULT_UCP_AGENT_META } }

            const response = await this._makeJsonRpcRequest(
                this.storefrontMcpEndpoint,
                'tools/list',
                params,
                headers
            )

            const toolsData = response.result?.tools || []
            const storefrontTools = this._formatToolsData(toolsData)

            this.storefrontTools = storefrontTools
            this.tools = [...this.tools, ...storefrontTools]

            return storefrontTools
        } catch (e) {
            logger.error(e, 'Failed to connect to MCP server')
            throw e
        }
    }

    async callTool(toolName, toolArgs) {
        if (this.storefrontTools.some((tool) => tool.name === toolName)) {
            return this.callStorefrontTool(toolName, toolArgs)
        }
        throw new Error(`Tool ${toolName} not found`)
    }

    async callStorefrontTool(toolName, toolArgs) {
        try {
            logger.info({ toolName, toolArgs }, 'Calling storefront tool')

            if (toolName === 'create_cart' && this.cartId) {
                return this.callStorefrontTool('update_cart', toolArgs)
            }

            const requiresCartId =
                AppConfig.tools.cartToolsRequiringId.includes(toolName)

            if (requiresCartId && !this.cartId) {
                return {
                    error: {
                        message: `Cannot call ${toolName}: no cart exists yet for this session.`,
                    },
                }
            }

            // update_cart replaces the entire line_items array server-side — it
            // is NOT additive. The model is only asked to supply the diff (new
            // item, or an existing line's id + new quantity), so we merge that
            // diff onto the cart's current state here before sending.
            if (toolName === 'update_cart') {
                toolArgs = await this._mergeCartLineItems(toolArgs)
            }

            // Hard cap search_catalog results at exactly
            // AppConfig.tools.searchCatalogLimit, regardless of what (if
            // anything) the model requested — never left to the MCP
            // server's own default.
            if (toolName === 'search_catalog') {
                toolArgs = this._applySearchCatalogLimit(toolArgs)
            }

            const headers = { 'Content-Type': 'application/json' }

            const response = await this._makeJsonRpcRequest(
                this.storefrontMcpEndpoint,
                'tools/call',
                {
                    name: toolName,
                    arguments: {
                        ...toolArgs,
                        meta: DEFAULT_UCP_AGENT_META,
                        ...(requiresCartId ? { id: this.cartId } : {}),
                    },
                },
                headers
            )

            const result = response.result || response

            if (
                (toolName === 'create_cart' || toolName === 'update_cart') &&
                result?.structuredContent?.id
            ) {
                this.cartId = result.structuredContent.id
            }
            if (toolName === 'cancel_cart') {
                this.cartId = null
            }

            return result
        } catch (error) {
            logger.error({ toolName }, error, 'Error calling tool')
            throw error
        }
    }

    _applySearchCatalogLimit(toolArgs) {
        return {
            ...toolArgs,
            catalog: {
                ...toolArgs?.catalog,
                pagination: {
                    ...toolArgs?.catalog?.pagination,
                    limit: AppConfig.tools.searchCatalogLimit,
                },
            },
        }
    }

    // Fetches the cart's current line items and layers the model's requested
    // diff on top, producing the full array update_cart actually needs.
    // - requested item WITH an id matching an existing line -> replace that
    //   line's quantity (quantity 0 removes it, per the tool's own contract).
    // - requested item WITH an id that does NOT match anything current ->
    //   stale/hallucinated id (e.g. from collapsed history); drop the id and
    //   treat it as a new line instead of silently failing.
    // - requested item with NO id -> new line, appended as-is.
    async _mergeCartLineItems(toolArgs) {
        const cartResult = await this.callStorefrontTool('get_cart', {})
        const existingLineItems =
            cartResult?.structuredContent?.line_items || []

        const requestedLineItems = toolArgs?.cart?.line_items || []

        const merged = new Map(
            existingLineItems.map((line) => [
                line.id,
                {
                    id: line.id,
                    item: { id: line.item.id },
                    quantity: line.quantity,
                },
            ])
        )

        let newLineCounter = 0
        for (const requested of requestedLineItems) {
            if (requested.id && merged.has(requested.id)) {
                if (requested.quantity === 0) {
                    merged.delete(requested.id)
                } else {
                    var existingLine = merged.get(requested.id)
                    merged.set(requested.id, {
                        id: requested.id,
                        // The model isn't required to repeat the variant id when it's
                        // only changing quantity on an existing line — fall back to
                        // what's already in the cart for that line if omitted.
                        item: { id: requested.item?.id || existingLine.item.id },
                        quantity: requested.quantity,
                    })
                }
                continue
            }

            if (requested.id && !merged.has(requested.id)) {
                logger.warn(
                    { requestedId: requested.id },
                    'update_cart referenced an unknown line item id — treating as new line'
                )
            }

            merged.set(`__new_${newLineCounter++}`, {
                item: { id: requested.item.id },
                quantity: requested.quantity,
            })
        }

        return {
            ...toolArgs,
            cart: { ...toolArgs.cart, line_items: [...merged.values()] },
        }
    }

    async _makeJsonRpcRequest(endpoint, method, params, headers) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', method, id: 1, params }),
        })

        if (!response.ok) {
            const error = await response.text()
            const errorObj = new Error(
                `Request failed: ${response.status} ${error}`
            )
            errorObj.status = response.status
            throw errorObj
        }

        return await response.json()
    }

    // Ignore whatever schema the MCP server advertises — use our own
    // minimal, hand-written schema for each tool we support. Tools we
    // haven't defined a minimal schema for are dropped entirely, so the
    // model is never offered a tool shaped by someone else's spec.
    _formatToolsData(toolsData) {
        return toolsData
            .filter((tool) =>
                Object.prototype.hasOwnProperty.call(
                    MINIMAL_TOOL_SCHEMAS,
                    tool.name
                )
            )
            .map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: MINIMAL_TOOL_SCHEMAS[tool.name],
            }))
    }
}

export default MCPClient
