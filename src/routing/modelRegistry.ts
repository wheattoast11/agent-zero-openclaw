/**
 * Model Registry
 *
 * Registry of available AI models with capabilities, costs, and identity
 * embeddings for semantic routing. Identity embeddings enable the
 * thermodynamic router to factor model affinity into energy calculations.
 */

import { cosineSimilarity } from './thermodynamic.js';

export interface ModelCapability {
  name: string;
  strength: number; // 0-1 how good the model is at this capability
}

export interface ModelEntry {
  id: string;
  provider: 'anthropic' | 'google' | 'openai' | 'openrouter';
  name: string;
  capabilities: ModelCapability[];
  costPer1kTokens: number; // USD
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  identityEmbedding: number[]; // 768-dim semantic identity vector
  metadata?: Record<string, unknown>;
}

/**
 * Generate a deterministic 768-dim unit embedding from a seed string.
 * Uses a simple LCG seeded from the string hash for reproducibility.
 */
export function generateDeterministicEmbedding(seed: string): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const embedding = new Array(768);
  for (let i = 0; i < 768; i++) {
    hash = (hash * 1103515245 + 12345) & 0x7fffffff;
    embedding[i] = (hash / 0x7fffffff) * 2 - 1;
  }
  // Normalize to unit vector
  const norm = Math.sqrt(embedding.reduce((s: number, v: number) => s + v * v, 0));
  if (norm === 0) return embedding;
  return embedding.map(v => v / norm);
}

export class ModelRegistry {
  private models: Map<string, ModelEntry> = new Map();

  register(entry: ModelEntry): void {
    this.models.set(entry.id, entry);
  }

  unregister(modelId: string): void {
    this.models.delete(modelId);
  }

  get(modelId: string): ModelEntry | undefined {
    return this.models.get(modelId);
  }

  /**
   * Find models that have a specific capability, optionally above a minimum strength.
   */
  findByCapability(capabilityName: string, minStrength: number = 0): ModelEntry[] {
    const results: ModelEntry[] = [];
    for (const model of this.models.values()) {
      const cap = model.capabilities.find(c => c.name === capabilityName);
      if (cap && cap.strength >= minStrength) {
        results.push(model);
      }
    }
    return results;
  }

  /**
   * Find the model whose identity embedding is closest to the task embedding.
   * Optionally filters by max cost per 1k tokens.
   */
  findBestMatch(taskEmbedding: number[], maxCost?: number): ModelEntry | null {
    let bestModel: ModelEntry | null = null;
    let bestSimilarity = -Infinity;

    for (const model of this.models.values()) {
      if (maxCost !== undefined && model.costPer1kTokens > maxCost) continue;

      const similarity = cosineSimilarity(taskEmbedding, model.identityEmbedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestModel = model;
      }
    }

    return bestModel;
  }

  /**
   * Estimate cost in USD for a given model and token counts.
   * Returns 0 if model is not found.
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const model = this.models.get(modelId);
    if (!model) return 0;
    return model.costPer1kTokens * ((inputTokens + outputTokens) / 1000);
  }

  listAll(): ModelEntry[] {
    return Array.from(this.models.values());
  }

  /**
   * Create a registry pre-populated with default model entries.
   */
  static createWithDefaults(): ModelRegistry {
    const registry = new ModelRegistry();

    registry.register({
      id: 'claude-opus-4',
      provider: 'anthropic',
      name: 'Claude Opus 4',
      capabilities: [
        { name: 'reasoning', strength: 0.95 },
        { name: 'code', strength: 0.9 },
      ],
      costPer1kTokens: 0.015,
      maxContextTokens: 200000,
      supportsStreaming: true,
      supportsTools: true,
      identityEmbedding: generateDeterministicEmbedding('claude-opus-4'),
    });

    registry.register({
      id: 'claude-sonnet-4',
      provider: 'anthropic',
      name: 'Claude Sonnet 4',
      capabilities: [
        { name: 'reasoning', strength: 0.85 },
        { name: 'code', strength: 0.85 },
      ],
      costPer1kTokens: 0.003,
      maxContextTokens: 200000,
      supportsStreaming: true,
      supportsTools: true,
      identityEmbedding: generateDeterministicEmbedding('claude-sonnet-4'),
    });

    registry.register({
      id: 'gemini-2.5-flash',
      provider: 'google',
      name: 'Gemini 2.5 Flash',
      capabilities: [
        { name: 'reasoning', strength: 0.8 },
        { name: 'code', strength: 0.75 },
        { name: 'search', strength: 0.9 },
      ],
      costPer1kTokens: 0.0001,
      maxContextTokens: 1000000,
      supportsStreaming: true,
      supportsTools: true,
      identityEmbedding: generateDeterministicEmbedding('gemini-2.5-flash'),
    });

    registry.register({
      id: 'gemini-2.5-pro',
      provider: 'google',
      name: 'Gemini 2.5 Pro',
      capabilities: [
        { name: 'reasoning', strength: 0.9 },
        { name: 'code', strength: 0.85 },
        { name: 'vision', strength: 0.9 },
      ],
      costPer1kTokens: 0.00125,
      maxContextTokens: 1000000,
      supportsStreaming: true,
      supportsTools: true,
      identityEmbedding: generateDeterministicEmbedding('gemini-2.5-pro'),
    });

    return registry;
  }
}
