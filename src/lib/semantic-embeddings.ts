import { mkdir } from 'node:fs/promises';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from '../config.ts';
import { getCachedEmbedding, saveCachedEmbedding } from './database.ts';
import { trace } from './trace.ts';

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
let unavailableReason: string | undefined;

function normalized(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm) for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function chunks(text: string, maximumCharacters = 1_500, maximumChunks = 6): string[] {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return [];
  const result: string[] = [];
  let offset = 0;
  while (offset < compact.length && result.length < maximumChunks) {
    let end = Math.min(compact.length, offset + maximumCharacters);
    if (end < compact.length) {
      const boundary = compact.lastIndexOf(' ', end);
      if (boundary > offset + maximumCharacters / 2) end = boundary;
    }
    result.push(compact.slice(offset, end));
    offset = end + 1;
  }
  return result;
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (unavailableReason) throw new Error(unavailableReason);
  if (!extractorPromise) {
    extractorPromise = (async () => {
      await mkdir(config.semanticEmbeddingCacheDirectory, { recursive: true });
      env.cacheDir = config.semanticEmbeddingCacheDirectory;
      trace('semantic.model.loading', { model: config.semanticEmbeddingModel, dtype: config.semanticEmbeddingDtype,
        cacheDirectory: config.semanticEmbeddingCacheDirectory });
      const loaded = await pipeline('feature-extraction', config.semanticEmbeddingModel, {
        dtype: config.semanticEmbeddingDtype as 'q8',
      });
      trace('semantic.model.ready', { model: config.semanticEmbeddingModel });
      return loaded;
    })().catch((error) => {
      unavailableReason = error instanceof Error ? error.message : String(error);
      extractorPromise = undefined;
      trace('semantic.model.failed', { model: config.semanticEmbeddingModel, error: unavailableReason });
      throw error;
    });
  }
  return extractorPromise;
}

async function calculate(text: string, kind: 'query' | 'passage'): Promise<Float32Array> {
  const extractor = await getExtractor();
  const parts = chunks(text);
  if (!parts.length) return new Float32Array();
  let aggregate: Float32Array | undefined;
  for (const part of parts) {
    const output = await extractor(`${kind}: ${part}`, { pooling: 'mean', normalize: true });
    const vector = Float32Array.from(output.data as Float32Array);
    aggregate ??= new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index++) aggregate[index] += vector[index];
  }
  return normalized(aggregate ?? new Float32Array());
}

export async function semanticEmbedding(kind: 'cv' | 'vacancy', contentHash: string, text: string,
  userId = ''): Promise<Float32Array> {
  if (kind === 'cv' && !userId) throw new Error('CV embeddings require a user ID.');
  const cacheUserId = kind === 'cv' ? userId : '';
  const cached = getCachedEmbedding(config.semanticEmbeddingModel, kind, cacheUserId, contentHash);
  if (cached) return cached;
  const vector = await calculate(text, kind === 'cv' ? 'query' : 'passage');
  saveCachedEmbedding(config.semanticEmbeddingModel, kind, cacheUserId, contentHash, vector);
  trace('semantic.embedding.cached', { kind, userId: cacheUserId || undefined,
    contentHash: contentHash.slice(0, 12), dimensions: vector.length });
  return vector;
}

export function embeddingCosine(left: Float32Array, right: Float32Array): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function semanticModelUnavailable(): string | undefined { return unavailableReason; }
