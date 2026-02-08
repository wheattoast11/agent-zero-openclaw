import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelRegistry,
  generateDeterministicEmbedding,
  type ModelEntry,
} from '../../src/routing/modelRegistry.js';

function makeEntry(id: string, overrides?: Partial<ModelEntry>): ModelEntry {
  return {
    id,
    provider: 'anthropic',
    name: id,
    capabilities: [{ name: 'reasoning', strength: 0.8 }],
    costPer1kTokens: 0.01,
    maxContextTokens: 100000,
    supportsStreaming: true,
    supportsTools: true,
    identityEmbedding: generateDeterministicEmbedding(id),
    ...overrides,
  };
}

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry();
  });

  it('registers and retrieves model entries', () => {
    const entry = makeEntry('test-model');
    registry.register(entry);
    const retrieved = registry.get('test-model');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('test-model');
    expect(retrieved!.provider).toBe('anthropic');
  });

  it('unregisters models', () => {
    registry.register(makeEntry('m1'));
    registry.register(makeEntry('m2'));
    registry.unregister('m1');
    expect(registry.get('m1')).toBeUndefined();
    expect(registry.get('m2')).toBeDefined();
  });

  it('finds models by capability name', () => {
    registry.register(
      makeEntry('coder', {
        capabilities: [
          { name: 'code', strength: 0.9 },
          { name: 'reasoning', strength: 0.7 },
        ],
      })
    );
    registry.register(
      makeEntry('searcher', {
        capabilities: [{ name: 'search', strength: 0.95 }],
      })
    );

    const codeModels = registry.findByCapability('code');
    expect(codeModels).toHaveLength(1);
    expect(codeModels[0].id).toBe('coder');

    const searchModels = registry.findByCapability('search');
    expect(searchModels).toHaveLength(1);
    expect(searchModels[0].id).toBe('searcher');

    const visionModels = registry.findByCapability('vision');
    expect(visionModels).toHaveLength(0);
  });

  it('finds models by capability with minimum strength filter', () => {
    registry.register(
      makeEntry('strong', {
        capabilities: [{ name: 'reasoning', strength: 0.95 }],
      })
    );
    registry.register(
      makeEntry('weak', {
        capabilities: [{ name: 'reasoning', strength: 0.5 }],
      })
    );

    const all = registry.findByCapability('reasoning', 0);
    expect(all).toHaveLength(2);

    const strongOnly = registry.findByCapability('reasoning', 0.9);
    expect(strongOnly).toHaveLength(1);
    expect(strongOnly[0].id).toBe('strong');
  });

  it('finds best match by task embedding (cosine similarity)', () => {
    const entry1 = makeEntry('model-a');
    const entry2 = makeEntry('model-b');
    registry.register(entry1);
    registry.register(entry2);

    // Use model-a's own embedding as task -- should match model-a best
    const best = registry.findBestMatch(entry1.identityEmbedding);
    expect(best).toBeDefined();
    expect(best!.id).toBe('model-a');
  });

  it('respects maxCost filter in findBestMatch', () => {
    registry.register(makeEntry('cheap', { costPer1kTokens: 0.001 }));
    registry.register(makeEntry('expensive', { costPer1kTokens: 1.0 }));

    // With low max cost, expensive model is excluded
    const best = registry.findBestMatch(
      generateDeterministicEmbedding('expensive'),
      0.01
    );
    // Should only return cheap model regardless of embedding match
    expect(best).toBeDefined();
    expect(best!.id).toBe('cheap');
  });

  it('returns null from findBestMatch when no models match cost', () => {
    registry.register(makeEntry('expensive', { costPer1kTokens: 10.0 }));
    const best = registry.findBestMatch(
      generateDeterministicEmbedding('expensive'),
      0.001
    );
    expect(best).toBeNull();
  });

  it('estimates cost correctly', () => {
    registry.register(makeEntry('m', { costPer1kTokens: 0.01 }));
    // 5000 input + 1000 output = 6000 total tokens = 6 * 0.01 = 0.06
    const cost = registry.estimateCost('m', 5000, 1000);
    expect(cost).toBeCloseTo(0.06, 6);
  });

  it('returns 0 cost for unknown model', () => {
    expect(registry.estimateCost('nonexistent', 1000, 1000)).toBe(0);
  });

  it('listAll returns all registered models', () => {
    registry.register(makeEntry('a'));
    registry.register(makeEntry('b'));
    registry.register(makeEntry('c'));
    const all = registry.listAll();
    expect(all).toHaveLength(3);
    const ids = all.map(m => m.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('ModelRegistry.createWithDefaults', () => {
  it('registers 4 default models', () => {
    const registry = ModelRegistry.createWithDefaults();
    const all = registry.listAll();
    expect(all).toHaveLength(4);

    const ids = all.map(m => m.id).sort();
    expect(ids).toEqual([
      'claude-opus-4',
      'claude-sonnet-4',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ]);
  });

  it('default models have valid identity embeddings', () => {
    const registry = ModelRegistry.createWithDefaults();
    for (const model of registry.listAll()) {
      expect(model.identityEmbedding).toHaveLength(768);
      // Should be unit vector (norm ~= 1)
      const norm = Math.sqrt(
        model.identityEmbedding.reduce((s, v) => s + v * v, 0)
      );
      expect(norm).toBeCloseTo(1.0, 3);
    }
  });
});

describe('generateDeterministicEmbedding', () => {
  it('is reproducible (same seed gives same output)', () => {
    const a = generateDeterministicEmbedding('test-seed');
    const b = generateDeterministicEmbedding('test-seed');
    expect(a).toEqual(b);
  });

  it('produces different embeddings for different seeds', () => {
    const a = generateDeterministicEmbedding('seed-a');
    const b = generateDeterministicEmbedding('seed-b');
    // At least some elements should differ
    const diffs = a.filter((v, i) => v !== b[i]);
    expect(diffs.length).toBeGreaterThan(0);
  });

  it('produces 768-dimensional unit vector', () => {
    const emb = generateDeterministicEmbedding('unit-test');
    expect(emb).toHaveLength(768);
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });
});
