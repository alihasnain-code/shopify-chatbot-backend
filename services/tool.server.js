import { logger } from '../config/logger.js'
import AppConfig from './config.server.js'

export function createToolService() {
    const handleToolError = async (toolUseResponse) => {
        logger.error(toolUseResponse.error, 'Tool use error')
    }

    const handleToolSuccess = async (
        toolUseResponse,
        toolName,
        productsToDisplay
    ) => {
        // Check if this is a product search result
        if (toolName === AppConfig.tools.productSearchName) {
            productsToDisplay.push(
                ...processProductSearchResult(toolUseResponse)
            )
        }
    }

    const processProductSearchResult = (toolUseResponse) => {
        try {
            logger.info('Processing product search result')
            let products = []

            if (toolUseResponse.content && toolUseResponse.content.length > 0) {
                const content = toolUseResponse.content[0].text

                try {
                    let responseData
                    if (typeof content === 'object') {
                        responseData = content
                    } else if (typeof content === 'string') {
                        responseData = JSON.parse(content)
                    }

                    if (
                        responseData?.products &&
                        Array.isArray(responseData.products)
                    ) {
                        products = responseData.products
                            .slice(0, AppConfig.tools.maxProductsToDisplay)
                            .map(formatProductData)

                        logger.info(
                            `Found ${products.length} products to display`
                        )
                    }
                } catch (e) {
                    logger.error(e, 'Error parsing product data')
                }
            }

            return products
        } catch (error) {
            logger.error(error, 'Error processing product search results')
            return []
        }
    }

    const formatProductData = (product) => {
        const price = product.price_range?.min
            ? `${product.price_range.min.currency} ${product.price_range.min.amount / 100}`
            : product.variants?.[0]?.price
                ? `${product.variants[0].price.currency} ${product.variants[0].price.amount / 100}`
                : 'Price not available'

        return {
            id: product.id || `product-${Math.random().toString(36).substring(7)}`,
            title: product.title || 'Product',
            price: price,
            image_url: product.media?.[0]?.url || '',
            description: product.description?.html || '',
            url: product.url || '',
        }
    }

    return {
        handleToolError,
        handleToolSuccess,
        processProductSearchResult,
    }
}

export default {
    createToolService,
}
