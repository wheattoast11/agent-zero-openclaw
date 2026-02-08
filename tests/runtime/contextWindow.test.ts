import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ContextWindow } from '../../src/runtime/contextWindow.js';
import { AgentZero } from '../../src/runtime/agent-zero.js';

// ============================================================================
// HELPERS
// ============================================================================

type Memory = {
  content: string;
  embedding: number[];
  importance: number;
  timestamp: number;
};

function makeMemory(content: string, importance: number, hoursAgo = 0): Memory {
  return {
    content,
    embedding: new Array(768).fill(0),
    importance,
    timestamp: Date.now() - hoursAgo * 3_600_000,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('ContextWindow', () => {
  let cw: ContextWindow;

  beforeEach(() => {
    cw = new ContextWindow({
      maxMemories: 5,
      maxTokenEstimate: 10000,
      evictionStrategy: 'combined',
      importanceDecay: 0.95,
      preserveThreshold: 0.9,
    });
  });

  it('isAtCapacity returns true when over maxMemories', () => {
    const memories = Array.from({ length: 6 }, (_, i) => makeMemory(`m${i}`, 0.5));
    expect(cw.isAtCapacity(memories)).toBe(true);
  });

  it('isAtCapacity returns false when under maxMemories', () => {
    const memories = Array.from({ length: 3 }, (_, i) => makeMemory(`m${i}`, 0.5));
    expect(cw.isAtCapacity(memories)).toBe(false);
  });

  it('isAtCapacity returns true when token estimate exceeded', () => {
    const bigCw = new ContextWindow({ maxMemories: 1000, maxTokenEstimate: 10 });
    const memories = [makeMemory('a'.repeat(100), 0.5)]; // 25 tokens > 10
    expect(bigCw.isAtCapacity(memories)).toBe(true);
  });

  it('selectForEviction returns lowest-scored memories', () => {
    const memories = [
      makeMemory('important', 0.8, 0),   // high importance, recent
      makeMemory('old-low', 0.1, 48),     // low importance, old
      makeMemory('medium', 0.5, 1),       // medium
      makeMemory('old-medium', 0.4, 24),  // medium importance, old
      makeMemory('recent-low', 0.2, 0),   // low importance, recent
    ];

    const evictIndices = cw.selectForEviction(memories, 2);
    expect(evictIndices).toHaveLength(2);
    // Should evict old-low (index 1) and old-medium (index 3) as they have lowest scores
    expect(evictIndices).toContain(1);
    expect(evictIndices).toContain(3);
  });

  it('evict removes correct memories', () => {
    const memories = [
      makeMemory('keep-high', 0.8, 0),
      makeMemory('evict-old', 0.1, 100),
      makeMemory('keep-mid', 0.5, 0),
      makeMemory('evict-old2', 0.1, 100),
      makeMemory('keep-recent', 0.3, 0),
      makeMemory('over-capacity', 0.2, 50), // 6th memory, over maxMemories=5
    ];

    const surviving = cw.evict(memories);
    expect(surviving.length).toBeLessThanOrEqual(5);
    // High importance memory should survive
    expect(surviving.some(m => m.content === 'keep-high')).toBe(true);
  });

  it('score combines importance and recency', () => {
    const recent = makeMemory('recent', 0.5, 0);
    const old = makeMemory('old', 0.5, 24);

    const recentScore = cw.score(recent);
    const oldScore = cw.score(old);

    // Recent memory should score higher than old with same importance
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it('importance decay reduces old memory scores', () => {
    const fresh = makeMemory('fresh', 0.8, 0);
    const stale = makeMemory('stale', 0.8, 100);

    expect(cw.score(fresh)).toBeGreaterThan(cw.score(stale));
  });

  it('preserveThreshold protects high-importance memories', () => {
    const memories = [
      makeMemory('preserved', 0.95, 100),  // Old but high importance
      makeMemory('low1', 0.1, 0),
      makeMemory('low2', 0.1, 0),
      makeMemory('low3', 0.1, 0),
      makeMemory('low4', 0.1, 0),
      makeMemory('low5', 0.1, 0),  // Over capacity
    ];

    const evictIndices = cw.selectForEviction(memories, 3);
    // Index 0 (preserved, importance 0.95 >= threshold 0.9) should NOT be in eviction list
    expect(evictIndices).not.toContain(0);
  });

  it('estimateTokens returns reasonable estimate', () => {
    const m = makeMemory('hello world', 0.5);
    const tokens = cw.estimateTokens(m);
    // "hello world" = 11 chars / 4 = ~3 tokens
    expect(tokens).toBeGreaterThanOrEqual(1);
    expect(tokens).toBeLessThan(100);
  });

  it('combined strategy evicts correctly', () => {
    // All defaults use combined
    const memories = [
      makeMemory('a', 0.8, 0),    // High score
      makeMemory('b', 0.1, 50),   // Low score (low importance + old)
      makeMemory('c', 0.6, 1),    // Medium-high
      makeMemory('d', 0.2, 30),   // Low score
      makeMemory('e', 0.7, 0),    // High
      makeMemory('f', 0.3, 0),    // Over capacity
    ];

    const result = cw.evict(memories);
    expect(result.length).toBeLessThanOrEqual(5);
    // b (low importance, very old) should be evicted
    expect(result.some(m => m.content === 'a')).toBe(true);
    expect(result.some(m => m.content === 'e')).toBe(true);
  });

  it('importance-only strategy uses decayed importance without recency bonus', () => {
    const importanceCw = new ContextWindow({
      maxMemories: 3,
      evictionStrategy: 'importance',
      importanceDecay: 1.0, // No decay — pure importance
    });

    const memories = [
      makeMemory('high-old', 0.8, 100),
      makeMemory('low-new', 0.1, 0),
      makeMemory('mid', 0.5, 10),
      makeMemory('over', 0.3, 5),
    ];

    const result = importanceCw.evict(memories);
    // With no decay, high-old (0.8) should survive despite being old
    expect(result.some(m => m.content === 'high-old')).toBe(true);
    // low-new (0.1) should be evicted despite being recent
    expect(result.some(m => m.content === 'low-new')).toBe(false);
  });

  it('recency-only strategy ignores importance', () => {
    const recencyCw = new ContextWindow({
      maxMemories: 3,
      evictionStrategy: 'recency',
      preserveThreshold: 1.0, // Disable preserve so importance doesn't protect
    });

    const memories = [
      makeMemory('old-high', 0.9, 100),
      makeMemory('new-low', 0.1, 0),
      makeMemory('newer', 0.2, 0),
      makeMemory('newest', 0.1, 0),
    ];

    const evictIndices = recencyCw.selectForEviction(memories, 1);
    // old-high (index 0) should be evicted despite high importance — recency only
    expect(evictIndices).toContain(0);
  });

  it('returns all memories when all are above preserveThreshold', () => {
    const memories = Array.from({ length: 6 }, (_, i) =>
      makeMemory(`preserved-${i}`, 0.95, i * 10)
    );

    const result = cw.evict(memories);
    // All memories are above 0.9 threshold, none can be evicted
    expect(result).toHaveLength(6);
    expect(result.every(m => m.content.startsWith('preserved-'))).toBe(true);
  });
});

// ============================================================================
// AGENT ZERO INTEGRATION
// ============================================================================

describe('ContextWindow + AgentZero integration', () => {
  it('eviction integrates with AgentZero.handlePercept', () => {
    const agent = new AgentZero({
      name: 'eviction-test',
      contextWindow: { maxMemories: 3 },
    });

    agent.start('test');

    // Add 5 percepts (exceeds maxMemories=3)
    for (let i = 0; i < 5; i++) {
      agent.receive({
        id: `percept-${i}`,
        kind: 'percept',
        from: '00000000-0000-0000-0000-000000000000',
        payload: `observation-${i}`,
        timestamp: Date.now(),
      });
      agent.processNext();
    }

    // Memories should be capped to maxMemories or fewer
    const state = agent.getState();
    expect(state.memories.length).toBeLessThanOrEqual(3);

    agent.destroy();
  });
});
