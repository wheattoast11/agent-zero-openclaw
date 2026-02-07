/**
 * Context Window Management
 *
 * Importance-weighted memory eviction when context exceeds limits.
 * Scoring combines importance (with temporal decay) and recency.
 * High-importance memories above preserveThreshold are never evicted.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ContextWindowConfig {
  /** Max number of memories (default 1000) */
  maxMemories: number;
  /** Rough token limit (default 100000) */
  maxTokenEstimate: number;
  /** Eviction strategy (default 'combined') */
  evictionStrategy: 'importance' | 'recency' | 'combined';
  /** Per-hour decay factor for importance (default 0.95) */
  importanceDecay: number;
  /** Memories above this importance are never evicted (default 0.9) */
  preserveThreshold: number;
}

type Memory = {
  content: string;
  embedding: number[];
  importance: number;
  timestamp: number;
};

const DEFAULT_CONFIG: ContextWindowConfig = {
  maxMemories: 1000,
  maxTokenEstimate: 100_000,
  evictionStrategy: 'combined',
  importanceDecay: 0.95,
  preserveThreshold: 0.9,
};

// ============================================================================
// CONTEXT WINDOW
// ============================================================================

export class ContextWindow {
  private config: ContextWindowConfig;

  constructor(config?: Partial<ContextWindowConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the memory set is at or over capacity.
   */
  isAtCapacity(memories: Memory[]): boolean {
    if (memories.length >= this.config.maxMemories) return true;

    let totalTokens = 0;
    for (const m of memories) {
      totalTokens += this.estimateTokens(m);
      if (totalTokens >= this.config.maxTokenEstimate) return true;
    }
    return false;
  }

  /**
   * Select indices of memories to evict (lowest-scored first).
   * Never selects memories above the preserve threshold.
   */
  selectForEviction(memories: Memory[], count: number): number[] {
    if (count <= 0 || memories.length === 0) return [];

    // Score all memories with their indices
    const scored: Array<{ index: number; score: number; preserved: boolean }> = memories.map((m, i) => ({
      index: i,
      score: this.score(m),
      preserved: m.importance >= this.config.preserveThreshold,
    }));

    // Filter out preserved memories
    const evictable = scored.filter(s => !s.preserved);

    // Sort by score ascending (lowest score = evict first)
    evictable.sort((a, b) => a.score - b.score);

    // Take up to `count` indices
    const toEvict = evictable.slice(0, count);
    return toEvict.map(e => e.index);
  }

  /**
   * Apply eviction: returns the surviving memories.
   * Removes lowest-scored memories until under capacity.
   */
  evict(memories: Memory[]): Memory[] {
    if (!this.isAtCapacity(memories)) return memories;

    // Calculate how many to remove
    const overCount = Math.max(0, memories.length - this.config.maxMemories);

    // Also check token estimate
    let totalTokens = 0;
    for (const m of memories) {
      totalTokens += this.estimateTokens(m);
    }
    const tokenOverage = totalTokens - this.config.maxTokenEstimate;

    // Determine eviction count: at least overCount, plus enough to get under token limit
    let evictCount = Math.max(overCount, 1); // evict at least 1 if at capacity

    if (tokenOverage > 0) {
      // Estimate average tokens per memory for additional evictions needed
      const avgTokens = totalTokens / memories.length;
      const tokenEvictions = Math.ceil(tokenOverage / avgTokens);
      evictCount = Math.max(evictCount, tokenEvictions);
    }

    const indicesToRemove = new Set(this.selectForEviction(memories, evictCount));

    if (indicesToRemove.size === 0) {
      // All memories are preserved, nothing we can evict
      return memories;
    }

    return memories.filter((_, i) => !indicesToRemove.has(i));
  }

  /**
   * Score a memory. Higher score = more valuable = kept longer.
   *
   * Combined strategy:
   *   score = importance * decay^hoursOld + recencyBonus
   *   recencyBonus = 1 / (1 + hoursOld)
   *
   * Importance-only: just the decayed importance.
   * Recency-only: just the recency bonus.
   */
  score(memory: Memory): number {
    const now = Date.now();
    const hoursOld = Math.max(0, (now - memory.timestamp) / 3_600_000);

    const decayedImportance = memory.importance * Math.pow(this.config.importanceDecay, hoursOld);
    const recencyBonus = 1 / (1 + hoursOld);

    switch (this.config.evictionStrategy) {
      case 'importance':
        return decayedImportance;
      case 'recency':
        return recencyBonus;
      case 'combined':
      default:
        return decayedImportance + recencyBonus;
    }
  }

  /**
   * Estimate token count for a memory.
   * Rough heuristic: ~4 characters per token for English text,
   * plus embedding vector storage overhead.
   */
  estimateTokens(memory: Memory): number {
    const contentTokens = Math.ceil(memory.content.length / 4);
    // Embedding: 768 floats, but we don't count them toward LLM context tokens
    // Only the content matters for context window usage
    return Math.max(1, contentTokens);
  }
}
