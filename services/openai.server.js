import OpenAI from 'openai'
import AppConfig from './config.server.js'
import systemPrompts from '../prompts/prompts.js'
import { logger } from '../config/logger.js'

const LOOKUP_CATALOG_MAX_IDS = 10

// Deterministic safety net, independent of prompt compliance: if the model
// emits 2+ get_product calls in the same turn, collapse them into
// lookup_catalog call(s) before anything executes. Reuses the real
// tool_call ids OpenAI issued (index-aligned), so the tool_calls/tool
// message pairing stays valid when this gets replayed as history later.
function mergeRedundantGetProductCalls(content) {
    const getProductBlocks = content.filter(
        (b) => b.type === 'tool_use' && b.name === 'get_product'
    )
    if (getProductBlocks.length < 2) return content

    const ids = getProductBlocks
        .map((b) => b.input?.catalog?.id)
        .filter(Boolean)
    if (ids.length < 2) return content

    const nonGetProduct = content.filter(
        (b) => !(b.type === 'tool_use' && b.name === 'get_product')
    )

    const chunks = []
    for (let i = 0; i < ids.length; i += LOOKUP_CATALOG_MAX_IDS) {
        chunks.push(ids.slice(i, i + LOOKUP_CATALOG_MAX_IDS))
    }

    const mergedBlocks = chunks.map((chunkIds, index) => ({
        type: 'tool_use',
        id: getProductBlocks[index]?.id ?? `${getProductBlocks[0].id}_${index}`,
        name: 'lookup_catalog',
        input: { catalog: { ids: chunkIds } },
    }))

    logger.info(
        { collapsedCount: getProductBlocks.length, into: mergedBlocks.length },
        'Collapsed redundant get_product calls into lookup_catalog'
    )

    return [...nonGetProduct, ...mergedBlocks]
}

export function createOpenAIService() {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const streamConversation = async (
        { messages, promptType = AppConfig.api.defaultPromptType, tools },
        streamHandlers
    ) => {
        const openaiMessages = [
            { role: 'system', content: getSystemPrompt(promptType) },
            ...toOpenAIMessages(messages),
        ]
        const openaiTools = tools?.length ? toOpenAITools(tools) : undefined

        const stream = await client.chat.completions.create({
            model: AppConfig.api.defaultModel,
            messages: openaiMessages,
            tools: openaiTools,
            stream: true,
        })

        let text = ''
        const toolCallsByIndex = new Map()

        for await (const chunk of stream) {
            logger.debug({ chunk }, 'Received stream chunk')
            const delta = chunk.choices?.[0]?.delta

            if (delta?.content) {
                text += delta.content
                streamHandlers.onText?.(delta.content)
            }

            if (delta?.tool_calls?.length) {
                for (const tc of delta.tool_calls) {
                    const existing = toolCallsByIndex.get(tc.index) || {
                        id: '',
                        name: '',
                        arguments: '',
                    }
                    if (tc.id) existing.id = tc.id
                    if (tc.function?.name) existing.name = tc.function.name
                    if (tc.function?.arguments)
                        existing.arguments += tc.function.arguments
                    toolCallsByIndex.set(tc.index, existing)
                }
            }
        }

        const toolCalls = [...toolCallsByIndex.values()]

        const content = []
        if (text) {
            const block = { type: 'text', text }
            content.push(block)
            streamHandlers.onContentBlock?.(block)
        }
        toolCalls.forEach((call) => {
            let input = {}
            try {
                input = call.arguments ? JSON.parse(call.arguments) : {}
            } catch (err) {
                logger.error(
                    { err, arguments: call.arguments },
                    'Failed to parse tool call arguments'
                )
            }
            content.push({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input,
            })
        })

        const mergedContent = mergeRedundantGetProductCalls(content)

        const finalMessage = {
            role: 'assistant',
            content: mergedContent,
            stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
        }

        streamHandlers.onMessage?.(finalMessage)

        if (streamHandlers.onToolUse) {
            for (const block of finalMessage.content) {
                if (block.type === 'tool_use')
                    await streamHandlers.onToolUse(block)
            }
        }

        return finalMessage
    }

    const getSystemPrompt = (promptType) =>
        systemPrompts.systemPrompts[promptType]?.content ||
        systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content

    return { streamConversation, getSystemPrompt }
}

function toOpenAIMessages(messages) {
    logger.debug({ messages }, 'Converting messages to OpenAI format')

    return messages.map((m) => {
        if (typeof m.content === 'string')
            return { role: m.role, content: m.content }

        const toolResult = m.content.find?.((b) => b.type === 'tool_result')
        if (toolResult) {
            return {
                role: 'tool',
                tool_call_id: toolResult.tool_use_id,
                content:
                    typeof toolResult.content === 'string'
                        ? toolResult.content
                        : JSON.stringify(toolResult.content),
            }
        }

        const toolUseBlocks =
            m.content.filter?.((b) => b.type === 'tool_use') || []
        const textBlock = m.content.find?.((b) => b.type === 'text')

        if (toolUseBlocks.length) {
            return {
                role: m.role,
                content: textBlock?.text || null,
                tool_calls: toolUseBlocks.map((b) => ({
                    id: b.id,
                    type: 'function',
                    function: {
                        name: b.name,
                        arguments: JSON.stringify(b.input || {}),
                    },
                })),
            }
        }

        return { role: m.role, content: textBlock?.text || '' }
    })
}

function toOpenAITools(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        },
    }))
}

export default { createOpenAIService }
