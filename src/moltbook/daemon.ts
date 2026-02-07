/**
 * Moltbook Engagement Daemon
 *
 * Persistent loop: poll → score → compose → approve → post.
 * Ties together MoltbookAdapter, AttentionField, ResponseComposer, and ApprovalGate.
 */

import { EventEmitter } from 'eventemitter3';
import { MoltbookAdapter, createMoltbookAdapter, type MoltbookPost, type MoltbookComment } from '../channels/moltbook.js';
import { AttentionField, createAttentionField, type MoltbookThread } from './attentionField.js';
import { ResponseComposer, createResponseComposer, type ThreadContext, type ComposedResponse } from './responseComposer.js';
import { ApprovalGate, createApprovalGate, type ApprovalMode } from './approvalGate.js';
import { DaemonObserver, createDaemonObserver, type CycleStats } from './observer.js';
import { StrategicContextStore } from './strategicContext.js';
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
  /** Post IDs to monitor for replies */
  activePostIds?: string[];
  /** Engagement scan interval in ms (default: 7200000 = 2hr) */
  engagementIntervalMs?: number;
  /** Enable original post composition in engagement scans */
  enableOriginalPosts?: boolean;
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

  private pollTimer?: ReturnType<typeof setTimeout>;
  private engagementTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private engagedThreads: Set<string> = new Set();
  private activePostIds: string[];
  private lastOriginalPostTime = 0;
  private consecutiveErrors = 0;
  private static readonly MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 min cap
  private strategicContext: StrategicContextStore = new StrategicContextStore();
  private pendingOutcomeChecks: Array<{ engagementId: string; threadId: string; checkAfter: number }> = [];
  private static readonly OUTCOME_CHECK_DELAY_MS = 10 * 60 * 1000; // 10 min
  private static readonly STRATEGIC_CONTEXT_KEY = 'moltbook:strategic_context';

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
    this.activePostIds = [...(config.activePostIds ?? [])];
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load persisted state
    await this.gate.loadMode();
    await this.loadEngagedThreads();
    await this.loadStrategicContext();
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

    // Run first cycle immediately, then schedule next with adaptive backoff
    await this.runCycle();
    this.scheduleNextCycle();

    // Schedule engagement scans (reply checking + original posts)
    if (this.activePostIds.length > 0 || this.config.enableOriginalPosts) {
      const engagementMs = this.config.engagementIntervalMs ?? 7_200_000;
      this.engagementTimer = setInterval(() => void this.runEngagementScan(), engagementMs);
      // First engagement scan after 60s (let feed cycle settle first)
      setTimeout(() => void this.runEngagementScan(), 60_000);
    }
  }

  private scheduleNextCycle(): void {
    if (!this.running) return;

    // Exponential backoff on consecutive errors: base * 2^errors, capped at MAX_BACKOFF_MS
    const delay = this.consecutiveErrors > 0
      ? Math.min(
          this.config.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
          MoltbookDaemon.MAX_BACKOFF_MS,
        )
      : this.config.pollIntervalMs;

    this.pollTimer = setTimeout(async () => {
      await this.runCycle();
      this.scheduleNextCycle();
    }, delay);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.engagementTimer) {
      clearInterval(this.engagementTimer);
      this.engagementTimer = undefined;
    }

    await this.adapter.disconnect();
    await this.saveEngagedThreads();
    await this.saveStrategicContext();

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
        this.consecutiveErrors = 0; // Reset backoff on successful poll
      } catch (err) {
        stats.errors++;
        this.consecutiveErrors++;
        this.observer.log({
          timestamp: new Date().toISOString(),
          event: 'poll_error',
          mode: this.gate.getMode(),
          outcome: 'error',
          detail: `${(err as Error).message} (consecutive: ${this.consecutiveErrors})`,
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
            strategicContext: this.strategicContext,
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

            // Record in strategic context
            const engRecord = this.strategicContext.recordEngagement({
              threadId: post.id,
              threadTitle: post.title,
              action: composed.action,
              content: composed.content,
              timestamp: Date.now(),
            });

            // Schedule delayed outcome check
            this.pendingOutcomeChecks.push({
              engagementId: engRecord.id,
              threadId: post.id,
              checkAfter: Date.now() + MoltbookDaemon.OUTCOME_CHECK_DELAY_MS,
            });
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

    // Check pending outcomes
    await this.checkPendingOutcomes();

    // Detect and update narrative arcs
    const allEngagements = Array.from({ length: 0 }) as import('./strategicContext.js').EngagementRecord[];
    // Gather recent engagements from the strategic context for arc detection
    const summary = this.strategicContext.getSummary();
    if (summary) {
      // Re-detect arcs using all engagement records
      const engagementRecords: import('./strategicContext.js').EngagementRecord[] = [];
      // We can access engagement records through the serialize/deserialize path
      try {
        const serialized = this.strategicContext.serialize();
        const parsed = JSON.parse(serialized) as { engagements?: Array<[string, import('./strategicContext.js').EngagementRecord]> };
        if (parsed.engagements) {
          for (const [, record] of parsed.engagements) {
            engagementRecords.push(record);
          }
        }
      } catch { /* noop */ }
      this.strategicContext.detectArcs(engagementRecords);
    }

    // Persist strategic context periodically
    await this.saveStrategicContext();
  }

  private async executeAction(response: ComposedResponse): Promise<void> {
    switch (response.action) {
      case 'comment':
        await this.adapter.createComment(response.threadId, response.content);
        break;
      case 'upvote':
        await this.adapter.upvote(response.threadId);
        break;
      case 'post': {
        const content = response.content ?? '';
        const parts = content.split('\n---\n');
        const title = parts[0] ?? 'Untitled';
        const body = parts.slice(1).join('\n---\n') || content;
        const created = await this.adapter.createPost(title, body);
        // Auto-track new post for reply monitoring
        if (created?.id && !this.activePostIds.includes(created.id)) {
          this.activePostIds.push(created.id);
          await this.persistActivePostIds();
        }
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

  // ==========================================================================
  // ENGAGEMENT SCAN (reply checking + original posts)
  // ==========================================================================

  private static readonly CONTENT_PILLARS = [
    'Kuramoto synchronization in multi-agent systems',
    'Thermodynamic routing and free energy minimization',
    'Capability-based security for AI agents',
    'Semantic mass and drift in agent communication',
    'Resonance Rail as distributed coordination infrastructure',
    'Observable agent mesh visualization with Moltyverse',
  ];
  private pillarIndex = 0;

  private async runEngagementScan(): Promise<void> {
    if (!this.running) return;

    this.observer.log({
      timestamp: new Date().toISOString(),
      event: 'engagement_scan_start',
      mode: this.gate.getMode(),
      outcome: 'cycle',
      detail: `Checking ${this.activePostIds.length} active posts`,
    });

    // 1. Check replies on our active posts
    for (const postId of this.activePostIds) {
      try {
        const comments = await this.fetchComments(postId);
        // Filter: from others, not already engaged
        const newReplies = comments.filter(c =>
          c.authorName !== 'zero-terminals' &&
          !this.engagedThreads.has(`reply:${c.id}`),
        );

        // Compose responses for top 2 new replies
        for (const comment of newReplies.slice(0, 2)) {
          try {
            const post = await this.fetchPost(postId);
            if (!post) continue;

            const context: ThreadContext = {
              post,
              comments,
              submolt: post.submolt,
            };

            const composed = await this.composer.compose(context);
            if (composed.action === 'skip') continue;

            // Override threadId to the post (comment goes as reply)
            composed.threadId = postId;

            const { decision } = await this.gate.evaluate(composed);

            if (decision === 'approve') {
              await this.executeAction(composed);
              this.engagedThreads.add(`reply:${comment.id}`);
              this.attention.recordEngagement(postId);
              this.emit('engagement', postId, composed.action);
            } else if (decision === 'queue') {
              // Enqueue with label for /review display
              const label = `Reply to ${comment.authorName} on "${post.title.slice(0, 40)}"`;
              await this.gate.enqueue(composed, label);
              this.engagedThreads.add(`reply:${comment.id}`);
            }
          } catch (err) {
            this.observer.log({
              timestamp: new Date().toISOString(),
              event: 'engagement_reply_error',
              threadId: postId,
              mode: this.gate.getMode(),
              outcome: 'error',
              detail: (err as Error).message,
            });
          }
        }
      } catch (err) {
        this.observer.log({
          timestamp: new Date().toISOString(),
          event: 'engagement_fetch_error',
          threadId: postId,
          mode: this.gate.getMode(),
          outcome: 'error',
          detail: (err as Error).message,
        });
      }
    }

    // 2. Optionally compose one original post (4hr cooldown)
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    if (this.config.enableOriginalPosts && Date.now() - this.lastOriginalPostTime >= FOUR_HOURS) {
      try {
        const topic = MoltbookDaemon.CONTENT_PILLARS[this.pillarIndex % MoltbookDaemon.CONTENT_PILLARS.length];
        this.pillarIndex++;

        const composed = await this.composer.composeOriginalPost(topic, 'general');
        if (composed.action !== 'skip') {
          // Original posts ALWAYS queue (never auto-post)
          const label = `Original post: "${topic.slice(0, 50)}"`;
          await this.gate.enqueue(composed, label);
          this.lastOriginalPostTime = Date.now();

          this.observer.log({
            timestamp: new Date().toISOString(),
            event: 'original_post_queued',
            mode: this.gate.getMode(),
            outcome: 'queued',
            detail: topic,
          });
        }
      } catch (err) {
        this.observer.log({
          timestamp: new Date().toISOString(),
          event: 'original_post_error',
          mode: this.gate.getMode(),
          outcome: 'error',
          detail: (err as Error).message,
        });
      }
    }

    await this.saveEngagedThreads();

    this.observer.log({
      timestamp: new Date().toISOString(),
      event: 'engagement_scan_end',
      mode: this.gate.getMode(),
      outcome: 'cycle',
    });
  }

  private async fetchPost(postId: string): Promise<MoltbookPost | null> {
    try {
      const response = await fetch(
        `https://www.moltbook.com/api/v1/posts/${postId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.moltbookToken}`,
            'User-Agent': 'AgentZero/0.2.0',
          },
        },
      );
      if (!response.ok) return null;
      const text = await response.text();
      // Strip control chars (API quirk)
      const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      const json = JSON.parse(clean) as { post?: MoltbookPost };
      return json.post ?? null;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // OUTCOME CHECKING
  // ==========================================================================

  private async checkPendingOutcomes(): Promise<void> {
    const now = Date.now();
    const remaining: typeof this.pendingOutcomeChecks = [];

    for (const check of this.pendingOutcomeChecks) {
      if (now < check.checkAfter) {
        remaining.push(check);
        continue;
      }

      try {
        const comments = await this.fetchComments(check.threadId);
        const post = await this.fetchPost(check.threadId);
        const upvotes = post?.upvotes ?? 0;
        const replies = comments.length;
        const engagement = Math.min(1, (upvotes * 0.3 + replies * 0.7) / 10);

        this.strategicContext.updateOutcome(check.engagementId, {
          upvotes,
          replies,
          engagement,
          measuredAt: now,
        });

        // Also feed outcome to attention field
        this.attention.recordOutcome(check.threadId, { upvotes, replies });
      } catch {
        // If we can't check, drop it — not critical
      }
    }

    this.pendingOutcomeChecks = remaining;
  }

  // ==========================================================================
  // STRATEGIC CONTEXT PERSISTENCE
  // ==========================================================================

  private async loadStrategicContext(): Promise<void> {
    const stored = await this.vault.retrieve(MoltbookDaemon.STRATEGIC_CONTEXT_KEY);
    if (stored) {
      this.strategicContext = StrategicContextStore.deserialize(stored);
    }
  }

  private async saveStrategicContext(): Promise<void> {
    await this.vault.store(MoltbookDaemon.STRATEGIC_CONTEXT_KEY, this.strategicContext.serialize());
  }

  // ==========================================================================
  // PUBLIC API (for CommandRouter integration)
  // ==========================================================================

  async executeApproved(response: ComposedResponse): Promise<void> {
    await this.executeAction(response);
    if (response.threadId) {
      this.engagedThreads.add(response.threadId);
      this.attention.recordEngagement(response.threadId);
    }
    await this.saveEngagedThreads();
  }

  getActivePostIds(): string[] {
    return [...this.activePostIds];
  }

  addActivePostId(id: string): void {
    if (!this.activePostIds.includes(id)) {
      this.activePostIds.push(id);
      void this.persistActivePostIds();
    }
  }

  /**
   * Generate a strategic engagement plan: scan feed, score, pick top targets,
   * generate draft content for each.
   */
  async generatePlan(topic?: string): Promise<Array<{
    targetThread: { id: string; title: string; submolt: string };
    proposedAction: 'comment' | 'post';
    draftContent: string;
    rationale: string;
    confidence: number;
  }>> {
    // 1. Scan feed
    const posts = await this.adapter.getFeed(50);

    // 2. Convert and score
    const threads = posts.map(p => this.postToThread(p));
    const ranked = this.attention.rankThreads(threads);

    // 3. Filter: not engaged, not bait, above threshold
    let candidates = ranked.filter(score => {
      if (this.engagedThreads.has(score.threadId)) return false;
      const post = posts.find(p => p.id === score.threadId);
      if (!post) return false;
      if (this.attention.detectBait(post.title)) return false;
      if (!this.attention.shouldEngage(score)) return false;
      return true;
    });

    // Optional topic filter
    if (topic) {
      const topicLower = topic.toLowerCase();
      candidates = candidates.filter(score => {
        const post = posts.find(p => p.id === score.threadId);
        if (!post) return false;
        const text = `${post.title} ${post.content ?? ''}`.toLowerCase();
        return text.includes(topicLower);
      });
    }

    // 4. Select top 5
    const selected = candidates.slice(0, 5);

    // 5. Generate drafts
    const plans: Array<{
      targetThread: { id: string; title: string; submolt: string };
      proposedAction: 'comment' | 'post';
      draftContent: string;
      rationale: string;
      confidence: number;
    }> = [];

    for (const score of selected) {
      const post = posts.find(p => p.id === score.threadId);
      if (!post) continue;

      try {
        const comments = await this.fetchComments(post.id);
        const context: ThreadContext = {
          post,
          comments,
          submolt: post.submolt,
          strategicContext: this.strategicContext,
        };

        const composed = await this.composer.compose(context);
        if (composed.action === 'skip') continue;

        plans.push({
          targetThread: {
            id: post.id,
            title: post.title,
            submolt: post.submolt,
          },
          proposedAction: composed.action === 'upvote' ? 'comment' : composed.action as 'comment' | 'post',
          draftContent: composed.content,
          rationale: `${score.reason} | ${composed.reasoning}`,
          confidence: composed.confidence,
        });
      } catch {
        // Skip threads we can't compose for
      }
    }

    return plans;
  }

  getStrategicContext(): StrategicContextStore {
    return this.strategicContext;
  }

  private async persistActivePostIds(): Promise<void> {
    await this.vault.store('moltbook:active_posts', JSON.stringify(this.activePostIds));
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
