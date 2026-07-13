import { logger } from '../config/logger.js'
import AppConfig from './config.server.js'

const PASSTHROUGH_TOOL_NAMES = new Set(AppConfig.tools.enabledToolNames)
const CATALOG_TOOLS = new Set([
    'search_catalog',
    'lookup_catalog',
    'get_product',
])
const CART_RESULT_TOOLS = new Set(['get_cart', 'create_cart', 'update_cart'])

const stripHtml = (html = '') =>
    html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

// Variant-level fields the model never needs to write a reply: full
// duplicated description, media, requires, checkout_url, sku. The full
// version of all of this still goes to the frontend via structuredContent
// — this only shrinks what's appended to conversationHistory for the LLM.
function shrinkVariant(variant, productPrice) {
    const out = {
        id: variant.id,
        title: variant.title,
        availability: variant.availability,
        options: variant.options,
    }
    // only include price if it actually differs from the product's baseline
    if (variant.price !== productPrice) out.price = variant.price
    if (variant.list_price) out.list_price = variant.list_price // omit when 0/falsy
    return out
}

function shrinkProduct(product) {
    const basePrice = product.price_range?.min?.amount
    return {
        id: product.id,
        title: product.title,
        description: product.description?.html
            ? stripHtml(product.description.html)
            : undefined,
        price_range: product.price_range,
        ...(product.list_price_range?.min?.amount
            ? { list_price_range: product.list_price_range }
            : {}),
        options: product.options,
        variants: (product.variants || []).map((v) =>
            shrinkVariant(v, basePrice)
        ),
    }
}

function shrinkCatalogPayload(data) {
    const out = { ...data }
    if (Array.isArray(out.products))
        out.products = out.products.map(shrinkProduct)
    if (out.product) out.product = shrinkProduct(out.product)
    return out
}

// Cart line items carry full image_url + nested item detail per line, and
// carts carry policy links (refund/privacy/terms) — none of which the
// model needs to confirm "added to cart" or summarize contents.
function shrinkLineItem(lineItem) {
    return {
        id: lineItem.id,
        item: {
            id: lineItem.item?.id,
            title: lineItem.item?.title,
            price: lineItem.item?.price,
        },
        quantity: lineItem.quantity,
        totals: lineItem.totals,
    }
}

function shrinkCartPayload(data) {
    const out = { ...data }
    if (Array.isArray(out.line_items))
        out.line_items = out.line_items.map(shrinkLineItem)
    delete out.links
    delete out.fulfillment
    return out
}

export function createToolService() {
    const handleToolError = async (toolUseResponse) => {
        logger.error(toolUseResponse.error, 'Tool use error')
    }

    const handleToolSuccess = (toolUseResponse, toolName) => {
        if (!PASSTHROUGH_TOOL_NAMES.has(toolName)) return null

        if (!toolUseResponse?.structuredContent) {
            logger.error(
                { toolName },
                'Tool response missing structuredContent'
            )
            return null
        }

        // Unchanged: this is what streams to the frontend, full payload.
        return {
            tool: toolName,
            data: toolUseResponse.structuredContent,
        }
    }

    // Trimmed payload for conversationHistory/model. Strips the static
    // UCP capability blob (always), then applies tool-specific shrinking
    // for catalog and cart results. Frontend is unaffected — it already
    // received the full structuredContent via handleToolSuccess above,
    // before this function ever runs.
    const buildModelToolResult = (toolUseResponse, toolName) => {
        if (!toolUseResponse?.structuredContent) return toolUseResponse

        const { ucp, ...rest } = toolUseResponse.structuredContent

        if (CATALOG_TOOLS.has(toolName)) return shrinkCatalogPayload(rest)
        if (CART_RESULT_TOOLS.has(toolName)) return shrinkCartPayload(rest)

        return rest
    }

    return {
        handleToolError,
        handleToolSuccess,
        buildModelToolResult,
    }
}

export default { createToolService }
