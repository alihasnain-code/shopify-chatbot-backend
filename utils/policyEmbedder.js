import { pipeline } from '@huggingface/transformers'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

// Singleton pattern to ensure the ~30MB model loads into RAM only once per worker process
class EmbeddingPipeline {
    static task = 'feature-extraction'
    static model = 'Xenova/all-MiniLM-L6-v2'
    static instance = null

    static async getInstance() {
        if (this.instance === null) {
            // Downloads and caches the model on first run
            this.instance = await pipeline(this.task, this.model)
        }
        return this.instance
    }
}

export async function chunkAndEmbedPolicy(cleanText, policyType) {
    if (!cleanText) return []

    // 1. Chunk the text (using the core, supported LangChain package)
    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 600,
        chunkOverlap: 90,
        separators: ['\n\n', '\n', '.', ' '],
    })

    const documents = await splitter.createDocuments([cleanText])
    if (documents.length === 0) return []

    const textChunks = documents.map((doc) => doc.pageContent)

    // 2. Load the native Hugging Face model
    const extractor = await EmbeddingPipeline.getInstance()

    // 3. Generate the embeddings natively
    // pooling: 'mean' and normalize: true are required to get the correct 384-dimension vector shape for MiniLM
    const output = await extractor(textChunks, {
        pooling: 'mean',
        normalize: true,
    })

    // Convert the output tensor into a standard JavaScript array of arrays
    const vectorEmbeddings = output.tolist()

    // 4. Map the chunks back to their vectors
    return documents.map((doc, index) => ({
        text: doc.pageContent,
        policyType,
        vector: vectorEmbeddings[index],
    }))
}

export async function embedQuery(text) {
    const extractor = await EmbeddingPipeline.getInstance()
    const output = await extractor([text], { pooling: 'mean', normalize: true })
    return output.tolist()[0]
}
