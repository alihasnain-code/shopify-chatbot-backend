import { logger } from '../config/logger.js'

class MCPClient {
    constructor(hostUrl) {
        this.tools = []
        this.storefrontTools = []

        this.storefrontMcpEndpoint = `${hostUrl}/api/mcp`
    }

    async connectToStorefrontServer() {
        try {
            logger.info(
                { endpoint: this.storefrontMcpEndpoint },
                'Connecting to MCP server'
            )

            const headers = {
                'Content-Type': 'application/json',
            }

            const response = await this._makeJsonRpcRequest(
                this.storefrontMcpEndpoint,
                'tools/list',
                {},
                headers
            )

            // Extract tools from the JSON-RPC response format
            const toolsData =
                response.result && response.result.tools
                    ? response.result.tools
                    : []
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
        } else {
            throw new Error(`Tool ${toolName} not found`)
        }
    }

    async callStorefrontTool(toolName, toolArgs) {
        try {
            logger.info(
                {
                    toolName,
                    toolArgs,
                },
                'Calling storefront tool'
            )

            const headers = {
                'Content-Type': 'application/json',
            }

            const response = await this._makeJsonRpcRequest(
                this.storefrontMcpEndpoint,
                'tools/call',
                {
                    name: toolName,
                    arguments: toolArgs,
                },
                headers
            )

            return response.result || response
        } catch (error) {
            logger.error(
                {
                    toolName,
                },
                error,
                'Error calling tool'
            )
            throw error
        }
    }

    async _makeJsonRpcRequest(endpoint, method, params, headers) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: method,
                id: 1,
                params: params,
            }),
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

    _formatToolsData(toolsData) {
        return toolsData.map((tool) => {
            return {
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema || tool.input_schema,
            }
        })
    }
}

export default MCPClient
