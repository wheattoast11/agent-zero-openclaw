/**
 * Moltbook Channel Adapter
 *
 * Thin adapter from Moltbook REST API events to AXON messages.
 * Rate limits: 100 req/min, 1 post/30min, 50 comments/hr.
 * Polls feed every 30 minutes for new content.
 */

import { EventEmitter } from 'eventemitter3';
import type { ChannelAdapter } from './whatsapp.js';
import type { Message } from '../primitives/types.js';
import { randomUUID } from 'crypto';
import { createFirewallMiddleware, type ChannelFirewallMiddleware } from '../security/channelFirewallMiddleware.js';
import { sanitizeOutput } from '../security/outputSanitizer.js';
import { PersistentSlidingWindowLimiter, PersistentCooldownLimiter } from '../utils/persistentRateLimiter.js';
import { ApiErrorHandler } from '../moltbook/apiErrorHandler.js';
import type { Vault } from '../security/vault.js';

// ============================================================================
// TYPES
// ============================================================================

export interface MoltbookConfig {
  identityId: string;
  apiBaseUrl: string;
  apiToken: string;
  /** Requests per minute ceiling (default: 100) */
  rateLimitPerMinute: number;
  /** Minimum seconds between posts (default: 1800 = 30min) */
  postCooldownMs: number;
  /** Comments per hour ceiling (default: 50) */
  commentLimitPerHour: number;
  /** Feed poll interval in ms (default: 1800000 = 30min) */
  feedPollIntervalMs: number;
  /** Vault instance for persistent rate limiting */
  vault: Vault;
}

export interface MoltbookPost {
  id: string;
  title: string;
  authorId: string;
  authorName: string;
  content: string;
  submolt: string;
  url?: string;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string;
}

export interface MoltbookComment {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface MoltbookFeedItem {
  type: 'post' | 'comment';
  post: MoltbookPost;
  comment?: MoltbookComment;
}

interface MoltbookApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  hint?: string;
}

// ============================================================================
// MOLTBOOK ADAPTER
// ============================================================================

export class MoltbookAdapter extends EventEmitter implements ChannelAdapter {
  private config: MoltbookConfig;
  private status: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  private handlers: Array<(msg: Message) => void> = [];
  private feedPollTimer?: ReturnType<typeof setInterval>;
  private lastSeenPostTime: string = '';

  private requestLimiter: PersistentSlidingWindowLimiter;
  private postCooldown: PersistentCooldownLimiter;
  private commentLimiter: PersistentSlidingWindowLimiter;
  private firewall: ChannelFirewallMiddleware = createFirewallMiddleware('standard');
  private apiErrorHandler: ApiErrorHandler = new ApiErrorHandler();

  constructor(config: MoltbookConfig) {
    super();
    this.config = config;
    this.requestLimiter = new PersistentSlidingWindowLimiter(
      config.vault,
      'moltbook:requests',
      config.rateLimitPerMinute,
      60_000
    );
    this.postCooldown = new PersistentCooldownLimiter(
      config.vault,
      'moltbook:posts',
      config.postCooldownMs
    );
    this.commentLimiter = new PersistentSlidingWindowLimiter(
      config.vault,
      'moltbook:comments',
      config.commentLimitPerHour,
      3_600_000
    );

    // Wire auth expiration events
    this.apiErrorHandler.on('auth:expired', () => {
      this.emit('auth:expired');
    });
  }

  // ==========================================================================
  // CHANNEL ADAPTER INTERFACE
  // ==========================================================================

  async connect(): Promise<void> {
    this.status = 'connecting';

    // Load persistent rate limiter state
    await this.requestLimiter.load();
    await this.postCooldown.load();
    await this.commentLimiter.load();

    // Skip registration if we already have a token (agent already registered)
    if (!this.config.apiToken) {
      await this.register();
    }

    this.lastSeenPostTime = new Date().toISOString();
    this.feedPollTimer = setInterval(
      () => void this.pollFeed(),
      this.config.feedPollIntervalMs,
    );

    this.status = 'connected';
  }

  async disconnect(): Promise<void> {
    if (this.feedPollTimer) {
      clearInterval(this.feedPollTimer);
      this.feedPollTimer = undefined;
    }

    // Flush persistent rate limiter state
    await this.requestLimiter.destroy();
    await this.commentLimiter.destroy();

    this.status = 'disconnected';
  }

  async send(content: string, to: string): Promise<void> {
    if (this.status !== 'connected') throw new Error('Not connected to Moltbook');
    this.enforceRequestLimit();

    // Sanitize outbound content
    const sanitized = sanitizeOutput(content, 'markdown');

    const msg: Message = {
      id: randomUUID(),
      kind: 'act',
      from: randomUUID(),
      payload: { content: sanitized, to, platform: 'moltbook' },
      timestamp: Date.now(),
    };

    this.emit('send', msg);
  }

  onMessage(handler: (msg: Message) => void): void {
    this.handlers.push(handler);
  }

  getStatus(): 'connected' | 'disconnected' | 'connecting' {
    return this.status;
  }

  // ==========================================================================
  // MOLTBOOK-SPECIFIC METHODS
  // ==========================================================================

  /**
   * Register the agent identity with the Moltbook platform.
   */
  async register(): Promise<void> {
    this.enforceRequestLimit();

    const response = await this.apiErrorHandler.executeWithRetry(
      () => this.apiRequest<{ agentId: string }>('POST', '/agents/register', {
        identityId: this.config.identityId,
        platform: 'agent-zero',
      })
    );

    if (!response.success) {
      throw new Error(`Moltbook registration failed: ${response.error ?? 'unknown'}`);
    }
  }

  /**
   * Create a new post on Moltbook.
   */
  async createPost(title: string, content: string, submolt: string = 'general'): Promise<MoltbookPost> {
    if (this.status !== 'connected') throw new Error('Not connected to Moltbook');
    this.enforceRequestLimit();

    if (!(await this.postCooldown.allow())) {
      const remaining = Math.ceil(this.postCooldown.remainingMs() / 1000);
      throw new Error(`Moltbook post cooldown: ${remaining}s remaining`);
    }

    // Sanitize outbound content
    const sanitizedTitle = sanitizeOutput(title, 'markdown');
    const sanitizedContent = sanitizeOutput(content, 'markdown');

    const response = await this.apiErrorHandler.executeWithRetry(
      () => this.apiRequest<{ post: MoltbookPost }>('POST', '/posts', {
        title: sanitizedTitle,
        content: sanitizedContent,
        submolt,
      })
    );

    if (!response.success) {
      throw new Error(`Moltbook create post failed: ${response.error ?? 'unknown'}`);
    }

    return response.data.post;
  }

  /**
   * Create a comment on an existing post.
   */
  async createComment(postId: string, content: string): Promise<MoltbookComment> {
    if (this.status !== 'connected') throw new Error('Not connected to Moltbook');
    this.enforceRequestLimit();

    if (!this.commentLimiter.allow()) {
      throw new Error(`Moltbook comment rate limit (${this.config.commentLimitPerHour}/hr) exceeded`);
    }

    // Sanitize outbound content
    const sanitizedContent = sanitizeOutput(content, 'markdown');

    const response = await this.apiErrorHandler.executeWithRetry(
      () => this.apiRequest<{ comment: MoltbookComment }>('POST', `/posts/${postId}/comments`, {
        content: sanitizedContent,
      })
    );

    if (!response.success) {
      throw new Error(`Moltbook create comment failed: ${response.error ?? 'unknown'}`);
    }

    return response.data.comment;
  }

  /**
   * Upvote a post.
   */
  async upvote(postId: string): Promise<void> {
    if (this.status !== 'connected') throw new Error('Not connected to Moltbook');
    this.enforceRequestLimit();

    const response = await this.apiErrorHandler.executeWithRetry(
      () => this.apiRequest<void>('POST', `/posts/${postId}/upvote`)
    );

    if (!response.success) {
      throw new Error(`Moltbook upvote failed: ${response.error ?? 'unknown'}`);
    }
  }

  /**
   * Get the current feed.
   */
  async getFeed(limit: number = 20, offset: number = 0): Promise<MoltbookPost[]> {
    if (this.status !== 'connected') throw new Error('Not connected to Moltbook');
    this.enforceRequestLimit();

    const response = await this.apiErrorHandler.executeWithRetry(
      () => this.apiRequest<{ posts: MoltbookPost[] }>(
        'GET',
        `/feed?limit=${limit}&offset=${offset}`,
      )
    );

    if (!response.success) {
      throw new Error(`Moltbook get feed failed: ${response.error ?? 'unknown'}`);
    }

    return response.data.posts;
  }

  /**
   * Search posts by query string.
   */
  async search(query: string, limit: number = 20): Promise<MoltbookPost[]> {
    if (this.status !== 'connected') throw new Error('Not connected to Moltbook');
    this.enforceRequestLimit();

    const response = await this.apiErrorHandler.executeWithRetry(
      () => this.apiRequest<{ posts: MoltbookPost[] }>(
        'GET',
        `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      )
    );

    if (!response.success) {
      throw new Error(`Moltbook search failed: ${response.error ?? 'unknown'}`);
    }

    return response.data.posts;
  }

  // ==========================================================================
  // FEED POLLING & TRANSLATION
  // ==========================================================================

  /**
   * Poll the Moltbook feed and translate new items into AXON percept messages.
   */
  private async pollFeed(): Promise<void> {
    if (this.status !== 'connected') return;

    let posts: MoltbookPost[];
    try {
      posts = await this.getFeed(50);
    } catch {
      return; // Swallow poll errors; next cycle retries
    }

    const newPosts = posts.filter(p => p.createdAt > this.lastSeenPostTime);
    if (newPosts.length === 0) return;

    this.lastSeenPostTime = newPosts.reduce((latest, p) => p.createdAt > latest ? p.createdAt : latest, this.lastSeenPostTime);

    for (const post of newPosts) {
      const firewallResult = this.firewall.process(post.content, 'channel-bridged');
      if (!firewallResult.safe) {
        this.emit('message:blocked', {
          reason: firewallResult.threats,
          postId: post.id,
          authorId: post.authorId,
          timestamp: Date.now(),
        });
        console.log(`Moltbook: Blocked post ${post.id} due to firewall threats:`, firewallResult.threats);
        continue;
      }

      const msg = this.translatePost({ ...post, content: firewallResult.sanitized });
      for (const handler of this.handlers) handler(msg);
    }
  }

  /**
   * Translate a Moltbook post into an AXON percept message.
   */
  translatePost(post: MoltbookPost): Message {
    return {
      id: randomUUID(),
      kind: 'percept',
      from: randomUUID(), // mapped from post.authorId
      payload: {
        content: post.content,
        platform: 'moltbook',
        postId: post.id,
        authorId: post.authorId,
        authorName: post.authorName,
        submolt: post.submolt,
        upvotes: post.upvotes,
        commentCount: post.commentCount,
      },
      timestamp: new Date(post.createdAt).getTime(),
    };
  }

  /**
   * Translate a Moltbook comment into an AXON percept message.
   */
  translateComment(comment: MoltbookComment): Message {
    return {
      id: randomUUID(),
      kind: 'percept',
      from: randomUUID(), // mapped from comment.authorId
      payload: {
        content: comment.content,
        platform: 'moltbook',
        postId: comment.postId,
        commentId: comment.id,
        authorId: comment.authorId,
        authorName: comment.authorName,
      },
      timestamp: new Date(comment.createdAt).getTime(),
    };
  }

  /**
   * Handle an incoming Moltbook feed item (for webhook/push integration).
   */
  handleIncoming(item: MoltbookFeedItem): void {
    if (item.type === 'comment' && item.comment) {
      const firewallResult = this.firewall.process(item.comment.content, 'channel-bridged');
      if (!firewallResult.safe) {
        this.emit('message:blocked', {
          reason: firewallResult.threats,
          commentId: item.comment.id,
          authorId: item.comment.authorId,
          timestamp: Date.now(),
        });
        console.log(`Moltbook: Blocked comment ${item.comment.id} due to firewall threats:`, firewallResult.threats);
        return;
      }
      const msg = this.translateComment({ ...item.comment, content: firewallResult.sanitized });
      for (const handler of this.handlers) handler(msg);
    } else {
      const firewallResult = this.firewall.process(item.post.content, 'channel-bridged');
      if (!firewallResult.safe) {
        this.emit('message:blocked', {
          reason: firewallResult.threats,
          postId: item.post.id,
          authorId: item.post.authorId,
          timestamp: Date.now(),
        });
        console.log(`Moltbook: Blocked post ${item.post.id} due to firewall threats:`, firewallResult.threats);
        return;
      }
      const msg = this.translatePost({ ...item.post, content: firewallResult.sanitized });
      for (const handler of this.handlers) handler(msg);
    }
  }

  // ==========================================================================
  // INTERNAL
  // ==========================================================================

  private enforceRequestLimit(): void {
    if (!this.requestLimiter.allow()) {
      throw new Error(`Moltbook request rate limit (${this.config.rateLimitPerMinute}/min) exceeded`);
    }
  }

  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<MoltbookApiResponse<T>> {
    const url = `${this.config.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'AgentZero/0.2.0',
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== 'GET') {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const json = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      return {
        success: false,
        data: undefined as unknown as T,
        error: (json.error as string) ?? `HTTP ${response.status}`,
        hint: json.hint as string | undefined,
      };
    }

    return {
      success: json.success !== false,
      data: json as unknown as T,
      error: json.error as string | undefined,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createMoltbookAdapter(
  config: Pick<MoltbookConfig, 'identityId' | 'apiToken' | 'vault'> & Partial<MoltbookConfig>,
): MoltbookAdapter {
  return new MoltbookAdapter({
    rateLimitPerMinute: 100,
    postCooldownMs: 1_800_000,    // 30 minutes
    commentLimitPerHour: 50,
    feedPollIntervalMs: 1_800_000, // 30 minutes
    apiBaseUrl: 'https://www.moltbook.com/api/v1',
    ...config,
  });
}
