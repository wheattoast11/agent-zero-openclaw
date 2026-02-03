/**
 * Telegram Channel Adapter
 *
 * Production-ready adapter from Telegram/grammY events to AXON messages.
 * Rate limits: configurable messages/second (default: 30).
 * Maintains stable userId → agentId mapping.
 * Supports chat whitelist for security.
 */

import { EventEmitter } from 'eventemitter3';
import { Bot } from 'grammy';
import type { ChannelAdapter } from './whatsapp.js';
import type { Message } from '../primitives/types.js';
import { randomUUID } from 'crypto';
import { createVault, type Vault } from '../security/vault.js';
import { createFirewallMiddleware, type ChannelFirewallMiddleware } from '../security/channelFirewallMiddleware.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TelegramConfig {
  identityId: string;
  /** Messages per second ceiling (default: 30) */
  rateLimitPerSecond: number;
  /** Bot token (optional - prefers vault retrieval) */
  botToken?: string;
  /** Allowed chat IDs whitelist (optional - if set, ignores other chats) */
  allowedChatIds?: number[];
  /** Vault passphrase for token retrieval (required if botToken not provided) */
  vaultPassphrase?: string;
}

// ============================================================================
// RATE LIMITER
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

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter(t => t > cutoff);
  }
}

// ============================================================================
// TELEGRAM ADAPTER
// ============================================================================

export class TelegramAdapter extends EventEmitter implements ChannelAdapter {
  private config: TelegramConfig;
  private status: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  private handlers: Array<(msg: Message) => void> = [];
  private bot?: Bot;
  private vault?: Vault;
  private sendLimiter: SlidingWindowLimiter;
  private userIdToAgentId: Map<number, string> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelayMs = 5000;
  private firewall: ChannelFirewallMiddleware = createFirewallMiddleware('standard');

  constructor(config: TelegramConfig) {
    super();
    this.config = config;
    this.sendLimiter = new SlidingWindowLimiter(config.rateLimitPerSecond, 1000);
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    try {
      let botToken = this.config.botToken;

      if (!botToken) {
        if (!this.config.vaultPassphrase) {
          throw new Error('Either botToken or vaultPassphrase must be provided');
        }

        this.vault = await createVault(this.config.vaultPassphrase);
        const vaultKey = `telegram:${this.config.identityId}`;
        const retrieved = await this.vault.retrieve(vaultKey);
        botToken = retrieved ?? undefined;

        if (!botToken) {
          throw new Error(`Bot token not found in vault for key: ${vaultKey}`);
        }
      }

      this.bot = new Bot(botToken);

      this.bot.on('message:text', async (ctx) => {
        try {
          await this.handleIncomingMessage(ctx);
        } catch (err) {
          console.error('Telegram message handler error:', err);
        }
      });

      this.bot.catch((err) => {
        console.error('Telegram bot error:', err);
        this.emit('error', err);

        if (this.status === 'connected') {
          void this.handleReconnect();
        }
      });

      await this.bot.start({
        onStart: (botInfo) => {
          console.log(`Telegram bot started: @${botInfo.username}`);
        },
      });

      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('connected');
    } catch (err) {
      this.status = 'disconnected';
      console.error('Telegram connection error:', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = undefined;
    }
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async send(content: string, to: string): Promise<void> {
    if (this.status !== 'connected') {
      throw new Error('Telegram adapter not connected');
    }

    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    if (!this.sendLimiter.check()) {
      throw new Error(`Telegram rate limit (${this.config.rateLimitPerSecond}/sec) exceeded`);
    }

    const chatId = parseInt(to, 10);
    if (isNaN(chatId)) {
      throw new Error(`Invalid chat ID: ${to}`);
    }

    try {
      await this.bot.api.sendMessage(chatId, content, {
        parse_mode: 'Markdown',
      });

      this.sendLimiter.record();

      const msg: Message = {
        id: randomUUID(),
        kind: 'act',
        from: this.config.identityId,
        to: undefined,
        payload: { content, chatId, platform: 'telegram' },
        timestamp: Date.now(),
      };

      this.emit('send', msg);
    } catch (err) {
      console.error(`Telegram send error to ${chatId}:`, err);
      throw err;
    }
  }

  async sendPhoto(chatId: number, photoUrl: string, caption?: string): Promise<void> {
    if (this.status !== 'connected' || !this.bot) {
      throw new Error('Telegram adapter not connected');
    }

    if (!this.sendLimiter.check()) {
      throw new Error(`Telegram rate limit (${this.config.rateLimitPerSecond}/sec) exceeded`);
    }

    try {
      await this.bot.api.sendPhoto(chatId, photoUrl, {
        caption,
        parse_mode: 'Markdown',
      });

      this.sendLimiter.record();
    } catch (err) {
      console.error(`Telegram sendPhoto error to ${chatId}:`, err);
      throw err;
    }
  }

  async sendDocument(chatId: number, documentUrl: string, caption?: string): Promise<void> {
    if (this.status !== 'connected' || !this.bot) {
      throw new Error('Telegram adapter not connected');
    }

    if (!this.sendLimiter.check()) {
      throw new Error(`Telegram rate limit (${this.config.rateLimitPerSecond}/sec) exceeded`);
    }

    try {
      await this.bot.api.sendDocument(chatId, documentUrl, {
        caption,
        parse_mode: 'Markdown',
      });

      this.sendLimiter.record();
    } catch (err) {
      console.error(`Telegram sendDocument error to ${chatId}:`, err);
      throw err;
    }
  }

  onMessage(handler: (msg: Message) => void): void {
    this.handlers.push(handler);
  }

  getStatus(): 'connected' | 'disconnected' | 'connecting' {
    return this.status;
  }

  private async handleIncomingMessage(ctx: any): Promise<void> {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    const firstName = ctx.from?.first_name;
    const text = ctx.message?.text;
    const messageId = ctx.message?.message_id;
    const timestamp = ctx.message?.date;

    if (!text || !chatId || !userId) return;

    if (this.config.allowedChatIds && !this.config.allowedChatIds.includes(chatId)) {
      console.log(`Telegram: Ignoring message from non-whitelisted chat ${chatId}`);
      return;
    }

    const firewallResult = this.firewall.process(text, 'channel-bridged');
    if (!firewallResult.safe) {
      this.emit('message:blocked', {
        reason: firewallResult.threats,
        chatId,
        userId,
        timestamp: Date.now(),
      });
      console.log(`Telegram: Blocked message from ${userId} due to firewall threats:`, firewallResult.threats);
      return;
    }

    let agentId = this.userIdToAgentId.get(userId);
    if (!agentId) {
      agentId = randomUUID();
      this.userIdToAgentId.set(userId, agentId);
    }

    const msg: Message = {
      id: randomUUID(),
      kind: 'percept',
      from: agentId,
      to: this.config.identityId,
      payload: {
        content: firewallResult.sanitized,
        platform: 'telegram',
        chatId,
        chatType,
        fromUsername: username,
        fromName: firstName,
        messageId,
        userId,
      },
      timestamp: timestamp * 1000,
    };

    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error('Telegram message handler error:', err);
      }
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Telegram: Max reconnect attempts reached, giving up');
      this.status = 'disconnected';
      this.emit('disconnected');
      return;
    }

    this.reconnectAttempts++;
    console.log(`Telegram: Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    await new Promise(resolve => setTimeout(resolve, this.reconnectDelayMs));

    try {
      await this.disconnect();
      await this.connect();
    } catch (err) {
      console.error('Telegram reconnect failed:', err);
      void this.handleReconnect();
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const DEFAULT_CONFIG: Partial<TelegramConfig> = {
  rateLimitPerSecond: 30,
};

export function createTelegramAdapter(
  config: Pick<TelegramConfig, 'identityId'> & Partial<TelegramConfig>,
): TelegramAdapter {
  return new TelegramAdapter({ ...DEFAULT_CONFIG, ...config } as TelegramConfig);
}
