/**
 * Strategic Context Store
 *
 * Tracks engagement history, thread outcomes, and narrative arcs
 * for context-aware Moltbook engagement.
 */

import { randomUUID } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface EngagementRecord {
  id: string;
  threadId: string;
  threadTitle?: string;
  action: 'comment' | 'post' | 'upvote' | 'skip';
  content?: string;
  timestamp: number;
  outcome?: {
    upvotes: number;
    replies: number;
    engagement: number;
    measuredAt: number;
  };
}

export interface NarrativeArc {
  id: string;
  topic: string;
  engagements: string[];
  startedAt: number;
  lastActivity: number;
  momentum: number;
  status: 'active' | 'dormant' | 'completed';
}

// ============================================================================
// CONTENT PILLARS (for arc detection)
// ============================================================================

const CONTENT_PILLARS: Array<{ key: string; patterns: RegExp[] }> = [
  {
    key: 'kuramoto-synchronization',
    patterns: [/kuramoto/i, /phase.?lock/i, /synchronization/i, /coherence/i, /oscillator/i],
  },
  {
    key: 'thermodynamic-routing',
    patterns: [/thermodynamic/i, /boltzmann/i, /free.?energy/i, /routing/i, /annealing/i],
  },
  {
    key: 'capability-security',
    patterns: [/capability/i, /sandbox/i, /security/i, /firewall/i, /injection/i],
  },
  {
    key: 'semantic-mass',
    patterns: [/semantic/i, /drift/i, /embedding/i, /gravity/i, /mass/i],
  },
  {
    key: 'resonance-rail',
    patterns: [/resonance/i, /rail/i, /distributed/i, /coordination/i, /websocket/i],
  },
  {
    key: 'moltyverse-visualization',
    patterns: [/moltyverse/i, /visualization/i, /3d/i, /mesh/i, /observable/i],
  },
];

// ============================================================================
// STRATEGIC CONTEXT STORE
// ============================================================================

export class StrategicContextStore {
  private engagements: Map<string, EngagementRecord> = new Map();
  private arcs: Map<string, NarrativeArc> = new Map();

  /**
   * Record an engagement and assign a UUID.
   */
  recordEngagement(record: Omit<EngagementRecord, 'id'>): EngagementRecord {
    const engagement: EngagementRecord = {
      ...record,
      id: randomUUID(),
    };
    this.engagements.set(engagement.id, engagement);
    return engagement;
  }

  /**
   * Update the measured outcome for a previously recorded engagement.
   */
  updateOutcome(engagementId: string, outcome: EngagementRecord['outcome']): void {
    const record = this.engagements.get(engagementId);
    if (record && outcome) {
      record.outcome = outcome;
    }
  }

  /**
   * Get all engagement records for a given thread.
   */
  getThreadHistory(threadId: string): EngagementRecord[] {
    const results: EngagementRecord[] = [];
    for (const record of this.engagements.values()) {
      if (record.threadId === threadId) {
        results.push(record);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Check if we have any engagement record for a thread.
   */
  hasEngaged(threadId: string): boolean {
    for (const record of this.engagements.values()) {
      if (record.threadId === threadId && record.action !== 'skip') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get or create a narrative arc for a topic.
   */
  getOrCreateArc(topic: string): NarrativeArc {
    const existing = this.arcs.get(topic);
    if (existing) return existing;

    const arc: NarrativeArc = {
      id: randomUUID(),
      topic,
      engagements: [],
      startedAt: Date.now(),
      lastActivity: Date.now(),
      momentum: 0,
      status: 'active',
    };
    this.arcs.set(topic, arc);
    return arc;
  }

  /**
   * Link an engagement record to a narrative arc.
   */
  linkEngagementToArc(engagementId: string, arcId: string): void {
    for (const arc of this.arcs.values()) {
      if (arc.id === arcId) {
        if (!arc.engagements.includes(engagementId)) {
          arc.engagements.push(engagementId);
          arc.lastActivity = Date.now();
        }
        return;
      }
    }
  }

  /**
   * Get all arcs with status 'active'.
   */
  getActiveArcs(): NarrativeArc[] {
    const active: NarrativeArc[] = [];
    for (const arc of this.arcs.values()) {
      if (arc.status === 'active') {
        active.push(arc);
      }
    }
    return active.sort((a, b) => b.momentum - a.momentum);
  }

  /**
   * Detect narrative arcs from a set of engagement records.
   * Groups by content pillar topic keywords; a topic with 2+ engagements
   * in the last 7 days creates an active arc.
   */
  detectArcs(engagements: EngagementRecord[]): NarrativeArc[] {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recentEngagements = engagements.filter(e => now - e.timestamp < SEVEN_DAYS);

    const topicBuckets = new Map<string, EngagementRecord[]>();

    for (const engagement of recentEngagements) {
      const text = `${engagement.threadTitle ?? ''} ${engagement.content ?? ''}`.toLowerCase();

      for (const pillar of CONTENT_PILLARS) {
        const matched = pillar.patterns.some(p => p.test(text));
        if (matched) {
          const bucket = topicBuckets.get(pillar.key) ?? [];
          bucket.push(engagement);
          topicBuckets.set(pillar.key, bucket);
        }
      }
    }

    const detectedArcs: NarrativeArc[] = [];

    for (const [topic, bucket] of topicBuckets) {
      if (bucket.length < 2) continue;

      const arc = this.getOrCreateArc(topic);
      for (const eng of bucket) {
        if (!arc.engagements.includes(eng.id)) {
          arc.engagements.push(eng.id);
        }
      }

      const timestamps = bucket.map(e => e.timestamp);
      arc.startedAt = Math.min(arc.startedAt, ...timestamps);
      arc.lastActivity = Math.max(arc.lastActivity, ...timestamps);
      arc.status = 'active';
      arc.momentum = this.calculateMomentum(arc);

      detectedArcs.push(arc);
    }

    // Mark arcs with no recent activity as dormant
    for (const arc of this.arcs.values()) {
      if (now - arc.lastActivity > SEVEN_DAYS && arc.status === 'active') {
        arc.status = 'dormant';
        arc.momentum = 0;
      }
    }

    return detectedArcs;
  }

  /**
   * Calculate momentum for an arc.
   * momentum = (recent_engagements_7d / 7) * avg_outcome_engagement
   */
  calculateMomentum(arc: NarrativeArc): number {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const recentEngagementIds = arc.engagements.filter(id => {
      const record = this.engagements.get(id);
      return record && now - record.timestamp < SEVEN_DAYS;
    });

    const recentCount = recentEngagementIds.length;
    if (recentCount === 0) return 0;

    // Average outcome engagement score from records that have outcomes
    let totalOutcome = 0;
    let outcomeCounted = 0;

    for (const id of recentEngagementIds) {
      const record = this.engagements.get(id);
      if (record?.outcome) {
        totalOutcome += record.outcome.engagement;
        outcomeCounted++;
      }
    }

    const avgOutcome = outcomeCounted > 0 ? totalOutcome / outcomeCounted : 0.5;
    const momentum = (recentCount / 7) * avgOutcome;

    return Math.min(1, momentum);
  }

  /**
   * Produce a formatted summary string for inclusion in LLM prompts.
   */
  getSummary(): string {
    const activeArcs = this.getActiveArcs();
    const recentEngagements = this.getRecentEngagements(7);

    const lines: string[] = [];

    if (activeArcs.length > 0) {
      lines.push('ACTIVE NARRATIVE ARCS:');
      for (const arc of activeArcs.slice(0, 5)) {
        lines.push(`- ${arc.topic}: ${arc.engagements.length} engagements, momentum ${arc.momentum.toFixed(2)}`);
        // Include most recent engagement content for continuity
        const lastEngId = arc.engagements[arc.engagements.length - 1];
        const lastEng = lastEngId ? this.engagements.get(lastEngId) : undefined;
        if (lastEng?.content) {
          lines.push(`  Last: "${lastEng.content.slice(0, 120)}"`);
        }
      }
    }

    if (recentEngagements.length > 0) {
      lines.push('');
      lines.push(`RECENT ENGAGEMENTS (last 7 days): ${recentEngagements.length}`);
      const withOutcomes = recentEngagements.filter(e => e.outcome);
      if (withOutcomes.length > 0) {
        const avgEng = withOutcomes.reduce((s, e) => s + (e.outcome?.engagement ?? 0), 0) / withOutcomes.length;
        lines.push(`Average outcome engagement: ${avgEng.toFixed(2)}`);
      }

      // List top 3 most recent for context
      for (const eng of recentEngagements.slice(-3)) {
        const title = eng.threadTitle ? `"${eng.threadTitle.slice(0, 60)}"` : eng.threadId;
        lines.push(`- ${eng.action} on ${title}${eng.outcome ? ` (engagement: ${eng.outcome.engagement})` : ''}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : '';
  }

  /**
   * Serialize the entire store to a JSON string for persistence.
   */
  serialize(): string {
    return JSON.stringify({
      engagements: Array.from(this.engagements.entries()),
      arcs: Array.from(this.arcs.entries()),
    });
  }

  /**
   * Deserialize a JSON string into a new StrategicContextStore instance.
   */
  static deserialize(data: string): StrategicContextStore {
    const store = new StrategicContextStore();
    try {
      const parsed = JSON.parse(data) as {
        engagements?: Array<[string, EngagementRecord]>;
        arcs?: Array<[string, NarrativeArc]>;
      };
      if (parsed.engagements) {
        store.engagements = new Map(parsed.engagements);
      }
      if (parsed.arcs) {
        store.arcs = new Map(parsed.arcs);
      }
    } catch {
      // Return empty store on parse failure
    }
    return store;
  }

  /**
   * Get all engagements from the last N days.
   */
  private getRecentEngagements(days: number): EngagementRecord[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const results: EngagementRecord[] = [];
    for (const record of this.engagements.values()) {
      if (record.timestamp >= cutoff) {
        results.push(record);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }
}
