/**
 * Twitter/X Channel Adapter
 *
 * Thin adapter using agent-twitter-client (Scraper) to AXON messages.
 * Rate limits: 50 tweets/day, 1 tweet/2min cooldown, mention polling every 60s.
 */

import { EventEmitter } from 'eventemitter3';
import type { ChannelAdapter } from './whatsapp.js';
import type { Message } from '../primitives/types.js';
import { randomUUID } from 'crypto';
import { Scraper, SearchMode, type Tweet } from 'agent-twitter-client';
import { createFirewallMiddleware, type ChannelFirewallMiddleware } from '../security/channelFirewallMiddleware.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TwitterConfig {
  identityId: string;
  username: string;
  password: string;
  email: string;
  /** Optional cookies for session restore */
  cookies?: string;
  /** Poll interval for mentions/timeline (default: 60000ms = 1 minute) */
  pollIntervalMs: number;
  /** Daily tweet limit (default: 50) */
  dailyTweetLimit: number;
  /** Cooldown between tweets in ms (default: 120000 = 2 minutes) */
  tweetCooldownMs: number;
}

export interface TwitterMention {
  tweetId: string;
  fromUsername: string;
  fromUserId: string;
  content: string;
  timestamp: number;
  isReply: boolean;
  replyToTweetId?: string;
}

// ============================================================================
// RATE LIMITER (from moltbook.ts pattern)
// ============================================================================

class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(): boolean {
    this.prune();
    return this.timestamps.length < this.maxRequests;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  remaining(): number {
    this.prune();
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter(t => t > cutoff);
  }
}

class CooldownLimiter {
  private lastAction: number = 0;
  private readonly cooldownMs: number;

  constructor(cooldownMs: number) {
    this.cooldownMs = cooldownMs;
  }

  check(): boolean {
    return Date.now() - this.lastAction >= this.cooldownMs;
  }

  record(): void {
    this.lastAction = Date.now();
  }

  remainingMs(): number {
    const elapsed = Date.now() - this.lastAction;
    return Math.max(0, this.cooldownMs - elapsed);
  }
}

// ============================================================================
// TWITTER ADAPTER
// ============================================================================

export class TwitterAdapter extends EventEmitter implements ChannelAdapter {
  private config: TwitterConfig;
  private status: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  private handlers: Array<(msg: Message) => void> = [];
  private scraper: Scraper;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastSeenMentionId?: string;

  private dailyTweetLimiter: SlidingWindowLimiter;
  private tweetCooldown: CooldownLimiter;
  private firewall: ChannelFirewallMiddleware = createFirewallMiddleware('standard');

  constructor(config: TwitterConfig) {
    super();
    this.config = config;
    this.scraper = new Scraper();
    this.dailyTweetLimiter = new SlidingWindowLimiter(config.dailyTweetLimit, 86_400_000); // 24 hours
    this.tweetCooldown = new CooldownLimiter(config.tweetCooldownMs);
  }

  // ==========================================================================
  // CHANNEL ADAPTER INTERFACE
  // ==========================================================================

  async connect(): Promise<void> {
    this.status = 'connecting';

    try {
      if (this.config.cookies) {
        await this.scraper.setCookies(JSON.parse(this.config.cookies));
      }

      const isLoggedIn = await this.scraper.isLoggedIn();

      if (!isLoggedIn) {
        await this.scraper.login(
          this.config.username,
          this.config.password,
          this.config.email,
        );
      }

      const loggedInCheck = await this.scraper.isLoggedIn();
      if (!loggedInCheck) {
        throw new Error('Twitter login verification failed');
      }

      this.pollTimer = setInterval(
        () => void this.pollMentions(),
        this.config.pollIntervalMs,
      );

      this.status = 'connected';
    } catch (error) {
      this.status = 'disconnected';
      throw new Error(`Twitter connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    try {
      await this.scraper.logout();
    } catch (error) {
      // Swallow logout errors; session may already be invalid
      void error;
    }

    this.status = 'disconnected';
  }

  async send(content: string, to?: string): Promise<void> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');
    this.enforceRateLimits();

    try {
      let tweetId: string | undefined;

      const response = to
        ? await this.scraper.sendTweet(content, to)
        : await this.scraper.sendTweet(content);

      if (!response.ok) throw new Error(`Tweet failed: HTTP ${response.status}`);

      try {
        const json = await response.json() as Record<string, unknown>;
        const result = (json?.data as Record<string, unknown>)?.create_tweet as Record<string, unknown>;
        const tweetResult = result?.tweet_results as Record<string, unknown>;
        tweetId = (tweetResult?.result as Record<string, string>)?.rest_id;
      } catch {
        // Tweet was sent but ID extraction failed — non-fatal
      }

      const msg: Message = {
        id: randomUUID(),
        kind: 'act',
        from: randomUUID(), // Agent ID
        payload: {
          content,
          platform: 'twitter',
          tweetId,
          replyTo: to,
        },
        timestamp: Date.now(),
      };

      this.dailyTweetLimiter.record();
      this.tweetCooldown.record();
      this.emit('send', msg);
    } catch (error) {
      throw new Error(`Twitter send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onMessage(handler: (msg: Message) => void): void {
    this.handlers.push(handler);
  }

  getStatus(): 'connected' | 'disconnected' | 'connecting' {
    return this.status;
  }

  // ==========================================================================
  // TWITTER-SPECIFIC METHODS
  // ==========================================================================

  /**
   * Post a thread (chain of tweets replying to each other).
   */
  async createThread(tweets: string[]): Promise<string[]> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');
    if (tweets.length === 0) throw new Error('Thread must contain at least one tweet');

    const tweetIds: string[] = [];
    let replyToId: string | undefined;

    for (const content of tweets) {
      this.enforceRateLimits();

      const response = await this.scraper.sendTweet(content, replyToId);
      if (!response.ok) throw new Error(`Thread tweet failed: HTTP ${response.status}`);

      let extractedId: string | undefined;
      try {
        const json = await response.json() as Record<string, unknown>;
        const result = (json?.data as Record<string, unknown>)?.create_tweet as Record<string, unknown>;
        const tweetResult = result?.tweet_results as Record<string, unknown>;
        extractedId = (tweetResult?.result as Record<string, string>)?.rest_id;
      } catch {
        // non-fatal
      }

      const id = extractedId ?? randomUUID();
      tweetIds.push(id);
      replyToId = extractedId;

      this.dailyTweetLimiter.record();
      this.tweetCooldown.record();

      // Wait for cooldown before next tweet
      if (tweets.indexOf(content) < tweets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, this.tweetCooldown.remainingMs()));
      }
    }

    return tweetIds;
  }

  /**
   * Like a tweet.
   */
  async like(tweetId: string): Promise<void> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');

    try {
      await this.scraper.likeTweet(tweetId);
    } catch (error) {
      throw new Error(`Twitter like failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Retweet a tweet.
   */
  async retweet(tweetId: string): Promise<void> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');

    try {
      await this.scraper.retweet(tweetId);
    } catch (error) {
      throw new Error(`Twitter retweet failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Follow a user.
   */
  async follow(username: string): Promise<void> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');

    try {
      await this.scraper.followUser(username);
    } catch (error) {
      throw new Error(`Twitter follow failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get timeline tweets.
   */
  async getTimeline(count: number = 20): Promise<Tweet[]> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');

    try {
      const tweets: Tweet[] = [];
      const iterator = this.scraper.getTweets(this.config.username, count);

      for await (const tweet of iterator) {
        tweets.push(tweet);
        if (tweets.length >= count) break;
      }

      return tweets;
    } catch (error) {
      throw new Error(`Twitter timeline fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Search for tweets matching a query.
   */
  async search(query: string, count: number = 20, mode: SearchMode = SearchMode.Latest): Promise<Tweet[]> {
    if (this.status !== 'connected') throw new Error('Not connected to Twitter');

    try {
      const tweets: Tweet[] = [];
      const iterator = this.scraper.searchTweets(query, count, mode);

      for await (const tweet of iterator) {
        tweets.push(tweet);
        if (tweets.length >= count) break;
      }

      return tweets;
    } catch (error) {
      throw new Error(`Twitter search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get current session cookies (for persistence).
   */
  async getCookies(): Promise<string> {
    const cookies = await this.scraper.getCookies();
    return JSON.stringify(cookies);
  }

  // ==========================================================================
  // MENTION POLLING & TRANSLATION
  // ==========================================================================

  /**
   * Poll for new mentions and translate to AXON percept messages.
   */
  private async pollMentions(): Promise<void> {
    if (this.status !== 'connected') return;

    try {
      const searchQuery = `@${this.config.username}`;
      const mentions = await this.search(searchQuery, 50, SearchMode.Latest);

      // Filter to only new mentions
      const newMentions = this.lastSeenMentionId
        ? mentions.filter(tweet => tweet.id !== this.lastSeenMentionId)
        : mentions;

      if (newMentions.length === 0) return;

      // Update last seen
      if (mentions.length > 0 && mentions[0].id) {
        this.lastSeenMentionId = mentions[0].id;
      }

      // Translate and dispatch
      for (const tweet of newMentions.reverse()) {
        if (!tweet.text) continue;

        const firewallResult = this.firewall.process(tweet.text, 'channel-bridged');
        if (!firewallResult.safe) {
          this.emit('message:blocked', {
            reason: firewallResult.threats,
            tweetId: tweet.id,
            fromUsername: tweet.username,
            timestamp: Date.now(),
          });
          console.log(`Twitter: Blocked tweet ${tweet.id} from @${tweet.username} due to firewall threats:`, firewallResult.threats);
          continue;
        }

        const msg = this.translateTweet({ ...tweet, text: firewallResult.sanitized });
        if (msg) {
          for (const handler of this.handlers) handler(msg);
        }
      }
    } catch (error) {
      // Swallow poll errors; next cycle retries
      void error;
    }
  }

  /**
   * Translate a Tweet object to AXON percept message.
   */
  private translateTweet(tweet: Tweet): Message | null {
    if (!tweet.text || !tweet.id) return null;

    return {
      id: randomUUID(),
      kind: 'percept',
      from: randomUUID(), // mapped from tweet.userId
      payload: {
        content: tweet.text,
        platform: 'twitter',
        tweetId: tweet.id,
        fromUsername: tweet.username ?? 'unknown',
        fromUserId: tweet.userId ?? 'unknown',
        isRetweet: tweet.isRetweet ?? false,
        isReply: tweet.isReply ?? false,
        replyToTweetId: tweet.inReplyToStatusId,
        likes: tweet.likes ?? 0,
        retweets: tweet.retweets ?? 0,
        replies: tweet.replies ?? 0,
        hashtags: tweet.hashtags ?? [],
        mentions: tweet.mentions ?? [],
        urls: tweet.urls ?? [],
      },
      timestamp: tweet.timestamp ? new Date(tweet.timestamp).getTime() : Date.now(),
    };
  }

  /**
   * Handle an incoming tweet (for webhook/push integration).
   */
  handleIncoming(tweet: Tweet): void {
    if (!tweet.text) return;

    const firewallResult = this.firewall.process(tweet.text, 'channel-bridged');
    if (!firewallResult.safe) {
      this.emit('message:blocked', {
        reason: firewallResult.threats,
        tweetId: tweet.id,
        fromUsername: tweet.username,
        timestamp: Date.now(),
      });
      console.log(`Twitter: Blocked incoming tweet ${tweet.id} from @${tweet.username} due to firewall threats:`, firewallResult.threats);
      return;
    }

    const msg = this.translateTweet({ ...tweet, text: firewallResult.sanitized });
    if (msg) {
      for (const handler of this.handlers) handler(msg);
    }
  }

  // ==========================================================================
  // INTERNAL
  // ==========================================================================

  private enforceRateLimits(): void {
    if (!this.dailyTweetLimiter.check()) {
      throw new Error(`Twitter daily tweet limit (${this.config.dailyTweetLimit}/day) exceeded. Remaining: ${this.dailyTweetLimiter.remaining()}`);
    }

    if (!this.tweetCooldown.check()) {
      const remaining = Math.ceil(this.tweetCooldown.remainingMs() / 1000);
      throw new Error(`Twitter tweet cooldown: ${remaining}s remaining`);
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const DEFAULT_CONFIG: Omit<TwitterConfig, 'identityId' | 'username' | 'password' | 'email'> = {
  pollIntervalMs: 60_000,       // 1 minute
  dailyTweetLimit: 50,
  tweetCooldownMs: 120_000,     // 2 minutes
};

export function createTwitterAdapter(
  config: Pick<TwitterConfig, 'identityId' | 'username' | 'password' | 'email'> & Partial<TwitterConfig>,
): TwitterAdapter {
  return new TwitterAdapter({ ...DEFAULT_CONFIG, ...config });
}
