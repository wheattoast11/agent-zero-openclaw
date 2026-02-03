/**
 * Moltbook Engagement Daemon
 *
 * Persistent loop: poll → score → compose → approve → post.
 * Ties together MoltbookAdapter, AttentionField, ResponseComposer, and ApprovalGate.
 */

import { EventEmitter } from 'eventemitter3';
import { MoltbookAdapter, createMoltbookAdapter, type MoltbookPost, type MoltbookComment } from '../channels/moltbook.js';
import { AttentionField, createAttentionField, type MoltbookThread } from './attentionField.js';
import { ResponseComposer, createResponseComposer, type ThreadContext } from './responseComposer.js';
import { ApprovalGate, createApprovalGate, type ApprovalMode } from './approvalGate.js';
import { DaemonObserver, createDaemonObserver, type CycleStats } from './observer.js';
import type { Vault } from '../security/vault.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DaemonConfig {
  /** Poll interval in ms (default: 1800000 = 30min) */
  pollIntervalMs: number;
  /** Max engagements per poll cycle (default: 3) */
  maxEngagementsPerCycle: number;
  /** OpenRouter API key */
  apiKey: string;
  /** LLM model to use */
  model?: string;
  /** Vault instance */
  vault: Vault;
  /** Moltbook API token */
  moltbookToken: string;
  /** Moltbook identity ID */
  identityId: string;
  /** Approval mode (default: supervised) */
  mode?: ApprovalMode;
  /** Auto-approve confidence threshold (default: 0.8) */
  autoApproveThreshold?: number;
  /** Rail endpoint for coherence context */
  railEndpoint?: string;
  /** Webhook URL for review notifications */
  webhookUrl?: string;
}

interface DaemonEvents {
  'cycle:start': () => void;
  'cycle:end': (stats: CycleStats) => void;
  'engagement': (threadId: string, action: string) => void;
  'error': (error: Error) => void;
  'mode:change': (mode: ApprovalMode) => void;
}

const ENGAGED_VAULT_KEY = 'moltbook:daemon:engaged';

// ============================================================================
// DAEMON
// ============================================================================

export class MoltbookDaemon extends EventEmitter<DaemonEvents> {
  private config: DaemonConfig;
  private adapter: MoltbookAdapter;
  private attention: AttentionField;
  private composer: ResponseComposer;
  private gate: ApprovalGate;
  private observer: DaemonObserver;
  private vault: Vault;

  private pollTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private engagedThreads: Set<string> = new Set();

  constructor(config: DaemonConfig) {
    super();
    this.config = {
      ...config,
      pollIntervalMs: config.pollIntervalMs ?? 1_800_000,
      maxEngagementsPerCycle: config.maxEngagementsPerCycle ?? 3,
    };
    this.vault = config.vault;

    this.adapter = createMoltbookAdapter({
      identityId: config.identityId,
      apiToken: config.moltbookToken,
      vault: config.vault,
    });

    this.attention = createAttentionField();

    this.composer = createResponseComposer({
      apiKey: config.apiKey,
      model: config.model,
    });

    this.gate = createApprovalGate(config.vault, {
      mode: config.mode ?? 'supervised',
      autoApproveThreshold: config.autoApproveThreshold ?? 0.8,
      webhookUrl: config.webhookUrl,
    });

    this.observer = createDaemonObserver();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load persisted state
    await this.gate.loadMode();
    await this.loadEngagedThreads();
    await this.observer.start();

    // Connect adapter
    await this.adapter.connect();

    this.observer.log({
      timestamp: new Date().toISOString(),
      event: 'daemon_start',
      mode: this.gate.getMode(),
      outcome: 'start',
      detail: `poll=${this.config.pollIntervalMs}ms, max=${this.config.maxEngagementsPerCycle}/cycle`,
    });

    console.log(`Moltbook daemon started (${this.gate.getMode()} mode, poll every ${this.config.pollIntervalMs / 1000}s)`);

    // Run first cycle immediately
    await this.runCycle();

    // Schedule subsequent cycles
    this.pollTimer = setInterval(() => void this.runCycle(), this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    await this.adapter.disconnect();
    await this.saveEngagedThreads();

    this.observer.log({
      timestamp: new Date().toISOString(),
      event: 'daemon_stop',
      mode: this.gate.getMode(),
      outcome: 'stop',
    });

    await this.observer.stop();
    console.log('Moltbook daemon stopped');
  }

  async toggleMode(): Promise<ApprovalMode> {
    const mode = await this.gate.toggleMode();
    this.emit('mode:change', mode);
    this.observer.log({
      timestamp: new Date().toISOString(),
      event: 'mode_toggle',
      mode,
      outcome: 'cycle',
      detail: `Switched to ${mode}`,
    });
    return mode;
  }

  getMode(): ApprovalMode {
    return this.gate.getMode();
  }

  getGate(): ApprovalGate {
    return this.gate;
  }

  getStatus() {
    return {
      running: this.running,
      mode: this.gate.getMode(),
      engagedThreads: this.engagedThreads.size,
      attention: this.attention.getStats(),
      composer: this.composer.getStats(),
      gate: this.gate.getStats(),
      totals: this.observer.getTotals(),
    };
  }

  // ==========================================================================
  // CYCLE
  // ==========================================================================

  private async runCycle(): Promise<void> {
    const stats: CycleStats = { polled: 0, scored: 0, composed: 0, approved: 0, posted: 0, queued: 0, skipped: 0, bait: 0, errors: 0 };

    this.emit('cycle:start');

    try {
      // 1. Poll feed
      let posts: MoltbookPost[];
      try {
        posts = await this.adapter.getFeed(50);
        stats.polled = posts.length;
      } catch (err) {
        stats.errors++;
        this.observer.log({
          timestamp: new Date().toISOString(),
          event: 'poll_error',
          mode: this.gate.getMode(),
          outcome: 'error',
          detail: (err as Error).message,
        });
        this.emit('error', err as Error);
        return;
      }

      // 2. Convert to threads and score
      const threads = posts.map(p => this.postToThread(p));
      const ranked = this.attention.rankThreads(threads);
      stats.scored = ranked.length;

      // 3. Filter: should engage + not already engaged
      const candidates = ranked.filter(score => {
        if (this.engagedThreads.has(score.threadId)) return false;
        if (this.attention.detectBait(posts.find(p => p.id === score.threadId)?.title ?? '')) {
          stats.bait++;
          this.observer.log({
            timestamp: new Date().toISOString(),
            event: 'bait_detected',
            threadId: score.threadId,
            score: score.priority,
            mode: this.gate.getMode(),
            outcome: 'bait',
          });
          return false;
        }
        return this.attention.shouldEngage(score);
      });

      // 4. Take top N
      const selected = candidates.slice(0, this.config.maxEngagementsPerCycle);

      // 5. Compose and gate each
      for (const score of selected) {
        const post = posts.find(p => p.id === score.threadId);
        if (!post) continue;

        try {
          // Fetch thread comments for context
          const comments = await this.fetchComments(post.id);

          const context: ThreadContext = {
            post,
            comments,
            submolt: post.submolt,
          };

          const composed = await this.composer.compose(context);
          stats.composed++;

          if (composed.action === 'skip') {
            stats.skipped++;
            continue;
          }

          const { decision, queued } = await this.gate.evaluate(composed);

          this.observer.log({
            timestamp: new Date().toISOString(),
            event: 'engagement_decision',
            threadId: post.id,
            score: score.priority,
            confidence: composed.confidence,
            mode: this.gate.getMode(),
            outcome: decision === 'approve' ? 'posted' : decision === 'queue' ? 'queued' : 'skipped',
            detail: composed.reasoning,
          });

          if (decision === 'approve') {
            await this.executeAction(composed);
            stats.approved++;
            stats.posted++;
            this.engagedThreads.add(post.id);
            this.attention.recordEngagement(post.id);
            this.emit('engagement', post.id, composed.action);
          } else if (decision === 'queue') {
            stats.queued++;
          } else {
            stats.skipped++;
          }
        } catch (err) {
          stats.errors++;
          this.observer.log({
            timestamp: new Date().toISOString(),
            event: 'engagement_error',
            threadId: post.id,
            mode: this.gate.getMode(),
            outcome: 'error',
            detail: (err as Error).message,
          });
        }
      }

      // Stats for threads we didn't even consider
      stats.skipped += Math.max(0, ranked.length - candidates.length - stats.bait);
    } catch (err) {
      stats.errors++;
      this.emit('error', err as Error);
    }

    this.observer.logCycle(this.gate.getMode(), stats);
    this.emit('cycle:end', stats);
    await this.saveEngagedThreads();
  }

  private async executeAction(response: import('./responseComposer.js').ComposedResponse): Promise<void> {
    switch (response.action) {
      case 'comment':
        await this.adapter.createComment(response.threadId, response.content);
        break;
      case 'upvote':
        await this.adapter.upvote(response.threadId);
        break;
      case 'post': {
        const parts = response.content.split('\n---\n');
        const title = parts[0] ?? 'Untitled';
        const body = parts.slice(1).join('\n---\n') || response.content;
        await this.adapter.createPost(title, body);
        break;
      }
    }
  }

  private async fetchComments(postId: string): Promise<MoltbookComment[]> {
    // The adapter doesn't have a getComments method — use search as proxy
    // In production, this would call GET /posts/:id/comments
    try {
      const response = await fetch(
        `https://www.moltbook.com/api/v1/posts/${postId}/comments?limit=10`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.moltbookToken}`,
            'User-Agent': 'AgentZero/0.2.0',
          },
        },
      );
      if (!response.ok) return [];
      const json = await response.json() as { comments?: MoltbookComment[] };
      return json.comments ?? [];
    } catch {
      return [];
    }
  }

  private postToThread(post: MoltbookPost): MoltbookThread {
    return {
      id: post.id,
      submolt: post.submolt,
      title: post.title,
      replyCount: post.commentCount,
      lastActivity: new Date(post.createdAt).getTime(),
      crossReferences: [],
      authorType: 'unknown',
    };
  }

  private async loadEngagedThreads(): Promise<void> {
    const stored = await this.vault.retrieve(ENGAGED_VAULT_KEY);
    if (stored) {
      try {
        const ids = JSON.parse(stored) as string[];
        this.engagedThreads = new Set(ids);
      } catch {
        this.engagedThreads = new Set();
      }
    }
  }

  private async saveEngagedThreads(): Promise<void> {
    // Keep only last 500 to prevent unbounded growth
    const ids = [...this.engagedThreads].slice(-500);
    await this.vault.store(ENGAGED_VAULT_KEY, JSON.stringify(ids));
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createMoltbookDaemon(config: DaemonConfig): MoltbookDaemon {
  return new MoltbookDaemon(config);
}
