import { GoogleGenAI } from '@google/genai'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || ''

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
})

export interface CommentWithEmbedding {
  id: string
  text: string
  authorName: string
  authorProfileImageUrl: string
  likeCount: number
  publishedAt: string
  embedding: number[]
}

/**
 * Clean text for embedding API - remove invalid characters and ensure valid input
 */
function cleanTextForEmbedding(text: string): string {
  if (!text) return ''
  
  let cleaned = text.trim().replace(/\s+/g, ' ')
  cleaned = cleaned.replace(/\0/g, '')
  
  if (cleaned.length > 8000) {
    cleaned = cleaned.slice(0, 8000)
  }
  
  return cleaned
}

/**
 * Delay helper for rate limiting
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Get embeddings for a batch of texts using Gemini's text-embedding-004
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const cleanedTexts = texts.map(cleanTextForEmbedding)
  const validIndices: number[] = []
  const validTexts: string[] = []
  
  cleanedTexts.forEach((text, i) => {
    if (text.length > 0) {
      validIndices.push(i)
      validTexts.push(text)
    }
  })

  if (validTexts.length === 0) {
    return texts.map(() => [])
  }

  const validEmbeddings: number[][] = []
  
  const CHUNK_SIZE = 10;
  for (let i = 0; i < validTexts.length; i += CHUNK_SIZE) {
    const chunk = validTexts.slice(i, i + CHUNK_SIZE)
    const chunkPromises = chunk.map(async (text) => {
      let attempt = 0
      const maxRetries = 3
      while (attempt < maxRetries) {
        try {
          const response = await ai.models.embedContent({
            model: 'gemini-embedding-2',
            contents: text,
          })
          return response.embeddings?.[0]?.values || []
        } catch (error: any) {
          if (error.status === 429) {
            attempt++
            if (attempt < maxRetries) {
              const backoffMs = Math.pow(2, attempt) * 1000
              console.log(`Rate limited. Exponential backoff: waiting ${backoffMs / 1000} seconds...`)
              await delay(backoffMs)
            } else {
              return []
            }
          } else {
            console.error('Embedding error:', error)
            return []
          }
        }
      }
      return []
    })
    
    const chunkResults = await Promise.all(chunkPromises)
    validEmbeddings.push(...chunkResults)
    await delay(300)
  }

  // Map embeddings back to original indices
  const result: number[][] = texts.map(() => [])
  validIndices.forEach((originalIdx, embeddingIdx) => {
    result[originalIdx] = validEmbeddings[embeddingIdx] || []
  })

  return result
}

/**
 * Add embeddings to comments
 */
export async function embedComments(
  comments: { id: string; text: string; authorName: string; authorProfileImageUrl: string; likeCount: number; publishedAt: string }[]
): Promise<CommentWithEmbedding[]> {
  const texts = comments.map(c => c.text)
  const embeddings = await getEmbeddings(texts)

  return comments.map((comment, i) => ({
    ...comment,
    embedding: embeddings[i] || []
  }))
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

/**
 * Compute distance matrix (1 - cosine similarity) for clustering
 */
export function computeDistanceMatrix(embeddings: number[][]): number[][] {
  const n = embeddings.length
  const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0))

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const distance = 1 - cosineSimilarity(embeddings[i], embeddings[j])
      matrix[i][j] = distance
      matrix[j][i] = distance
    }
  }

  return matrix
}
