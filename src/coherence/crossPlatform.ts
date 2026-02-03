/**
 * Cross-Platform Coherence
 *
 * Unified identity and conversation threading across WhatsApp, Telegram, Moltbook.
 * Agents maintain coherence through shared core identity regardless of platform.
 */

const THREAD_CORRELATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SIMILARITY_THRESHOLD = 0.6; // Content similarity for thread correlation

export interface PlatformIdentity {
  platform: string;
  handle: string;
  burnerId: string | null;
}

export interface UnifiedAgent {
  coreId: string;
  name: string;
  identities: PlatformIdentity[];
  currentPhase: number;
  lastSync: number;
}

export interface CrossPlatformThread {
  threadId: string;
  platforms: string[];
  messages: Array<{
    platform: string;
    content: string;
    timestamp: number;
    fromAgent: string;
  }>;
  context: string;
}

interface InternalAgent extends UnifiedAgent {
  threadIds: Set<string>;
}

export class CrossPlatformCoherence {
  private agents = new Map<string, InternalAgent>();
  private platformIndex = new Map<string, string>(); // "platform:handle" → coreId
  private threads = new Map<string, CrossPlatformThread>();

  constructor() {}

  registerIdentity(
    coreId: string,
    name: string,
    platform: string,
    handle: string,
    burnerId?: string
  ): UnifiedAgent {
    const indexKey = `${platform}:${handle}`;

    let agent = this.agents.get(coreId);
    if (!agent) {
      agent = {
        coreId,
        name,
        identities: [],
        currentPhase: 0,
        lastSync: Date.now(),
        threadIds: new Set()
      };
      this.agents.set(coreId, agent);
    }

    // Check if identity already exists
    const existing = agent.identities.find(
      id => id.platform === platform && id.handle === handle
    );

    if (!existing) {
      agent.identities.push({
        platform,
        handle,
        burnerId: burnerId ?? null
      });
    } else if (burnerId && !existing.burnerId) {
      existing.burnerId = burnerId;
    }

    this.platformIndex.set(indexKey, coreId);

    return this.stripInternal(agent);
  }

  resolveAgent(platform: string, handle: string): UnifiedAgent | null {
    const indexKey = `${platform}:${handle}`;
    const coreId = this.platformIndex.get(indexKey);
    if (!coreId) return null;

    const agent = this.agents.get(coreId);
    return agent ? this.stripInternal(agent) : null;
  }

  correlateThread(
    platform: string,
    messageContent: string,
    fromHandle: string,
    timestamp: number,
    embedding?: number[]
  ): CrossPlatformThread {
    const agent = this.resolveAgent(platform, fromHandle);
    if (!agent) {
      throw new Error(`Unknown agent ${platform}:${fromHandle}`);
    }

    const normalized = this.normalizeMessage(platform, messageContent);

    // Find existing thread: same agent + similar content + time window
    // Use sliding window search over 5 minutes instead of last-message-only
    for (const thread of this.threads.values()) {
      if (thread.messages.length === 0) continue;

      // Filter messages in time window from same agent
      const windowStart = timestamp - THREAD_CORRELATION_WINDOW_MS;
      const candidateMessages = thread.messages.filter(
        msg => msg.fromAgent === agent.coreId && msg.timestamp >= windowStart && msg.timestamp <= timestamp
      );

      if (candidateMessages.length === 0) continue;

      // Check content similarity with any message in window
      for (const candidateMsg of candidateMessages) {
        const jaccardSimilarity = this.contentSimilarity(normalized, candidateMsg.content);

        if (jaccardSimilarity >= SIMILARITY_THRESHOLD) {
          // Add to existing thread
          thread.messages.push({
            platform,
            content: normalized,
            timestamp,
            fromAgent: agent.coreId
          });
          if (!thread.platforms.includes(platform)) {
            thread.platforms.push(platform);
          }
          thread.context = this.extractContext(thread.messages);
          return thread;
        }

        // Embedding similarity fallback: if word-based Jaccard is below threshold but embeddings exist
        if (jaccardSimilarity < SIMILARITY_THRESHOLD && embedding && (candidateMsg as any).embedding) {
          const embeddingSimilarity = this.cosineSimilarity(embedding, (candidateMsg as any).embedding);
          if (embeddingSimilarity >= 0.7) {
            // Add to existing thread
            thread.messages.push({
              platform,
              content: normalized,
              timestamp,
              fromAgent: agent.coreId,
              ...(embedding && { embedding })
            } as any);
            if (!thread.platforms.includes(platform)) {
              thread.platforms.push(platform);
            }
            thread.context = this.extractContext(thread.messages);
            return thread;
          }
        }
      }
    }

    // Create new thread
    const threadId = this.generateThreadId(agent.coreId, timestamp);
    const thread: CrossPlatformThread = {
      threadId,
      platforms: [platform],
      messages: [{
        platform,
        content: normalized,
        timestamp,
        fromAgent: agent.coreId,
        ...(embedding && { embedding })
      } as any],
      context: normalized
    };

    this.threads.set(threadId, thread);
    const internalAgent = this.agents.get(agent.coreId);
    if (internalAgent) {
      internalAgent.threadIds.add(threadId);
    }

    return thread;
  }

  syncPhase(coreId: string, phase: number): void {
    const agent = this.agents.get(coreId);
    if (!agent) {
      throw new Error(`Agent ${coreId} not found`);
    }
    agent.currentPhase = phase;
    agent.lastSync = Date.now();
  }

  getUnifiedView(): Array<UnifiedAgent & { threadCount: number }> {
    return Array.from(this.agents.values()).map(agent => ({
      ...this.stripInternal(agent),
      threadCount: agent.threadIds.size
    }));
  }

  normalizeMessage(platform: string, rawContent: string): string {
    let content = rawContent.trim();

    switch (platform.toLowerCase()) {
      case 'whatsapp':
        // Remove WhatsApp bold *text*, italic _text_
        content = content.replace(/\*([^*]+)\*/g, '$1');
        content = content.replace(/_([^_]+)_/g, '$1');
        break;
      case 'telegram':
        // Remove Telegram /commands at start
        content = content.replace(/^\/\w+\s*/, '');
        break;
      case 'moltbook':
        // Remove Moltbook metadata tags
        content = content.replace(/\[@\w+\]/g, '');
        break;
    }

    return content.trim();
  }

  getStats(): { agents: number; platforms: Record<string, number>; activeThreads: number } {
    const platformCounts: Record<string, number> = {};

    for (const agent of this.agents.values()) {
      for (const identity of agent.identities) {
        platformCounts[identity.platform] = (platformCounts[identity.platform] || 0) + 1;
      }
    }

    return {
      agents: this.agents.size,
      platforms: platformCounts,
      activeThreads: this.threads.size
    };
  }

  private stripInternal(agent: InternalAgent): UnifiedAgent {
    return {
      coreId: agent.coreId,
      name: agent.name,
      identities: agent.identities,
      currentPhase: agent.currentPhase,
      lastSync: agent.lastSync
    };
  }

  private generateThreadId(coreId: string, timestamp: number): string {
    return `thread_${coreId}_${timestamp}`;
  }

  private contentSimilarity(a: string, b: string): number {
    const wordsA = a.toLowerCase().split(/\s+/);
    const wordsB = b.toLowerCase().split(/\s+/);
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    const intersection = new Set([...setA].filter(w => setB.has(w)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private extractContext(messages: CrossPlatformThread['messages']): string {
    // Last 3 messages as context
    const recent = messages.slice(-3);
    return recent.map(m => m.content).join(' ');
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (normA * normB);
  }
}

export function createCrossPlatformCoherence(): CrossPlatformCoherence {
  return new CrossPlatformCoherence();
}
