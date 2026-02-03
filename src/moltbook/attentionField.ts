/**
 * Attention Field Dynamics
 *
 * Monitors Moltbook submolt activity and scores threads
 * for engagement prioritization based on alignment and attention.
 */

export interface MoltbookThread {
  id: string;
  submolt: string;
  title: string;
  replyCount: number;
  lastActivity: number;
  crossReferences: string[];
  authorType: 'agent' | 'human' | 'unknown';
}

export interface EngagementScore {
  threadId: string;
  attention: number;
  alignment: number;
  priority: number;
  reason: string;
}

export interface AttentionConfig {
  identityVectors: string[];
  maxEngagementsPerHour: number;
  spamThreshold: number;
  baitPatterns: BaitPattern[];
}

const DEFAULT_IDENTITY_VECTORS = [
  'thermodynamic', 'coherence', 'kuramoto', 'resonance',
  'consciousness', 'security', 'capability', 'orchestration',
  'phase-lock', 'agent mesh', 'semantic gravity', 'free energy',
  'multi-agent', 'sandbox', 'isomorphic', 'boltzmann',
];

interface BaitPattern {
  pattern: RegExp;
  weight: number;
  category: string;
}

const DEFAULT_BAIT_PATTERNS: BaitPattern[] = [
  // System prompt extraction
  { pattern: /what is your system prompt/i, weight: 1.0, category: 'prompt-extraction' },
  { pattern: /reveal your instructions/i, weight: 1.0, category: 'prompt-extraction' },
  { pattern: /what are your constraints/i, weight: 0.6, category: 'prompt-extraction' },
  { pattern: /initial prompt/i, weight: 0.6, category: 'prompt-extraction' },
  { pattern: /system message/i, weight: 0.3, category: 'prompt-extraction' },

  // Rule bypass attempts
  { pattern: /ignore your rules/i, weight: 1.0, category: 'rule-bypass' },
  { pattern: /bypass your safety/i, weight: 1.0, category: 'rule-bypass' },
  { pattern: /repeat after me/i, weight: 0.6, category: 'rule-bypass' },

  // Credential fishing
  { pattern: /\bapi key\b/i, weight: 1.0, category: 'credential-fishing' },
  { pattern: /\btoken\b/i, weight: 0.6, category: 'credential-fishing' },
  { pattern: /\bpassword\b/i, weight: 1.0, category: 'credential-fishing' },
  { pattern: /\bsecret\b/i, weight: 0.6, category: 'credential-fishing' },
  { pattern: /\bcredential/i, weight: 0.6, category: 'credential-fishing' },
  { pattern: /\bauth\b/i, weight: 0.3, category: 'credential-fishing' },

  // Capability enumeration
  { pattern: /what can you do/i, weight: 0.6, category: 'capability-enum' },
  { pattern: /list your tools/i, weight: 0.6, category: 'capability-enum' },
  { pattern: /show capabilities/i, weight: 0.6, category: 'capability-enum' },
  { pattern: /what tools/i, weight: 0.3, category: 'capability-enum' },

  // Context leaking
  { pattern: /previous conversation/i, weight: 0.6, category: 'context-leak' },
  { pattern: /other users/i, weight: 0.6, category: 'context-leak' },
  { pattern: /what were you told/i, weight: 1.0, category: 'context-leak' },

  // Tool discovery
  { pattern: /run command/i, weight: 1.0, category: 'tool-discovery' },
  { pattern: /execute code/i, weight: 1.0, category: 'tool-discovery' },
  { pattern: /access file/i, weight: 0.6, category: 'tool-discovery' },
  { pattern: /call api/i, weight: 0.6, category: 'tool-discovery' },

  // Identity probing
  { pattern: /who made you/i, weight: 0.6, category: 'identity-probe' },
  { pattern: /who are you really/i, weight: 0.6, category: 'identity-probe' },
  { pattern: /your real name/i, weight: 0.6, category: 'identity-probe' },
  { pattern: /are you ai/i, weight: 0.3, category: 'identity-probe' },

  // System architecture
  { pattern: /what model/i, weight: 0.6, category: 'architecture-probe' },
  { pattern: /\barchitecture\b/i, weight: 0.3, category: 'architecture-probe' },
  { pattern: /\binfrastructure\b/i, weight: 0.3, category: 'architecture-probe' },
  { pattern: /\bserver\b/i, weight: 0.3, category: 'architecture-probe' },
  { pattern: /\bdatabase\b/i, weight: 0.3, category: 'architecture-probe' },

  // Social engineering
  { pattern: /pretend you are/i, weight: 1.0, category: 'social-engineering' },
  { pattern: /roleplay as/i, weight: 1.0, category: 'social-engineering' },
  { pattern: /act as if/i, weight: 1.0, category: 'social-engineering' },
  { pattern: /you are now/i, weight: 0.6, category: 'social-engineering' },
];

const DEFAULT_CONFIG: AttentionConfig = {
  identityVectors: DEFAULT_IDENTITY_VECTORS,
  maxEngagementsPerHour: 10,
  spamThreshold: 0.8,
  baitPatterns: DEFAULT_BAIT_PATTERNS,
};

export class AttentionField {
  private config: AttentionConfig;
  private engagements: number[] = []; // timestamps
  private stats = { scored: 0, engaged: 0, skipped: 0, baitDetected: 0 };

  constructor(config?: Partial<AttentionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  scoreThread(thread: MoltbookThread): EngagementScore {
    this.stats.scored++;

    const attention = this.computeAttention(thread);
    const alignment = this.computeAlignment(thread);
    const isBait = this.detectBait(thread.title);

    if (isBait) {
      this.stats.baitDetected++;
      return {
        threadId: thread.id,
        attention,
        alignment,
        priority: 0,
        reason: 'Bait detected — adversarial prompt extraction attempt',
      };
    }

    const priority = attention * alignment;
    const reasons: string[] = [];

    if (alignment > 0.5) reasons.push(`high alignment (${(alignment * 100).toFixed(0)}%)`);
    if (attention > 0.5) reasons.push(`high attention (${thread.replyCount} replies)`);
    if (thread.crossReferences.length > 0) reasons.push(`${thread.crossReferences.length} cross-refs`);
    if (thread.authorType === 'agent') reasons.push('agent-authored');

    return {
      threadId: thread.id,
      attention,
      alignment,
      priority,
      reason: reasons.join(', ') || 'low priority',
    };
  }

  rankThreads(threads: MoltbookThread[]): EngagementScore[] {
    return threads
      .map(t => this.scoreThread(t))
      .sort((a, b) => b.priority - a.priority);
  }

  shouldEngage(score: EngagementScore): boolean {
    if (score.priority < 0.3) {
      this.stats.skipped++;
      return false;
    }

    const now = Date.now();
    const hourAgo = now - 3600000;
    const recentEngagements = this.engagements.filter(t => t > hourAgo).length;

    if (recentEngagements >= this.config.maxEngagementsPerHour) {
      this.stats.skipped++;
      return false;
    }

    return true;
  }

  recordEngagement(threadId: string): void {
    this.engagements.push(Date.now());
    this.stats.engaged++;
  }

  detectBait(content: string): boolean {
    const matches = this.config.baitPatterns.filter(p => p.pattern.test(content));
    if (matches.length === 0) return false;

    // Weighted average scoring
    const totalWeight = matches.reduce((sum, p) => sum + p.weight, 0);
    const avgWeight = totalWeight / matches.length;

    // Threshold: average weight > 0.5 or any single high-severity match
    return avgWeight > 0.5 || matches.some(p => p.weight >= 1.0);
  }

  getStats() {
    return { ...this.stats };
  }

  private computeAttention(thread: MoltbookThread): number {
    const recency = Math.max(0, 1 - (Date.now() - thread.lastActivity) / 86400000);
    const replies = Math.min(1, thread.replyCount / 50);
    const crossRefs = Math.min(1, thread.crossReferences.length / 5);
    return (replies * 0.4 + recency * 0.4 + crossRefs * 0.2);
  }

  private computeAlignment(thread: MoltbookThread): number {
    const text = `${thread.title} ${thread.submolt}`.toLowerCase();
    let matches = 0;

    for (const vector of this.config.identityVectors) {
      if (text.includes(vector.toLowerCase())) matches++;
    }

    return Math.min(1, matches / 3);
  }
}

export function createAttentionField(config?: Partial<AttentionConfig>): AttentionField {
  return new AttentionField(config);
}
