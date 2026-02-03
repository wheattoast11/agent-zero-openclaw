/**
 * WhatsApp Channel Adapter
 *
 * Production-ready adapter using Baileys for WhatsApp Web multi-device
 * and Twilio for burner phone number provisioning.
 */

import { EventEmitter } from 'eventemitter3';
import type { Message } from '../primitives/types.js';
import type { Vault } from '../security/vault.js';
import { randomUUID } from 'crypto';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type ConnectionState,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createFirewallMiddleware, type ChannelFirewallMiddleware } from '../security/channelFirewallMiddleware.js';

// ============================================================================
// SILENT LOGGER — suppresses noisy Baileys JSON log output
// ============================================================================

const silentLogger = {
  level: 'silent' as const,
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
};

// ============================================================================
// TYPES
// ============================================================================

export interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(content: string, to: string): Promise<void>;
  onMessage(handler: (msg: Message) => void): void;
  getStatus(): 'connected' | 'disconnected' | 'connecting';
}

export interface WhatsAppConfig {
  identityId: string;
  dailyMessageLimit?: number;
  authDir?: string;
  phoneNumber?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  autoRotate?: boolean;
  rotateIntervalMs?: number;
}

interface TwilioPhoneNumber {
  phoneNumber: string;
  sid: string;
}

interface BaileysMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message?: proto.IMessage;
  messageTimestamp?: number | Long;
}

// ============================================================================
// RATE LIMITERS
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

class DailyLimiter {
  private count = 0;
  private resetTime = 0;
  private readonly dailyLimit: number;

  constructor(dailyLimit: number) {
    this.dailyLimit = dailyLimit;
    this.resetTime = Date.now() + 86400000;
  }

  check(): boolean {
    this.maybeReset();
    return this.count < this.dailyLimit;
  }

  record(): void {
    this.maybeReset();
    this.count++;
  }

  remaining(): number {
    this.maybeReset();
    return Math.max(0, this.dailyLimit - this.count);
  }

  private maybeReset(): void {
    if (Date.now() > this.resetTime) {
      this.count = 0;
      this.resetTime = Date.now() + 86400000;
    }
  }
}

// ============================================================================
// TWILIO BURNER PROVISIONER
// ============================================================================

export class TwilioBurnerProvisioner {
  private accountSid: string;
  private authToken: string;

  constructor(accountSid: string, authToken: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
  }

  async provision(country: string = 'US'): Promise<TwilioPhoneNumber> {
    const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;

    const searchUrl = `${baseUrl}/AvailablePhoneNumbers/${country}/Local.json?SmsEnabled=true&MmsEnabled=true&VoiceEnabled=true&Limit=1`;

    const authHeader = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;

    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: authHeader },
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.text();
      throw new Error(`Twilio search failed: ${error}`);
    }

    const searchData = await searchResponse.json() as { available_phone_numbers: Array<{ phone_number: string }> };
    const availableNumbers = searchData.available_phone_numbers;

    if (!availableNumbers || availableNumbers.length === 0) {
      throw new Error(`No available phone numbers in ${country}`);
    }

    const phoneNumber = availableNumbers[0].phone_number;

    const purchaseUrl = `${baseUrl}/IncomingPhoneNumbers.json`;
    const purchaseResponse = await fetch(purchaseUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        PhoneNumber: phoneNumber,
        SmsUrl: 'https://webhook.site/noop',
        VoiceUrl: 'https://webhook.site/noop',
      }),
    });

    if (!purchaseResponse.ok) {
      const error = await purchaseResponse.text();
      throw new Error(`Twilio purchase failed: ${error}`);
    }

    const purchaseData = await purchaseResponse.json() as { sid: string; phone_number: string };

    const waUrl = `${baseUrl}/IncomingPhoneNumbers/${purchaseData.sid}.json`;
    const waResponse = await fetch(waUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        SmsApplicationSid: '',
      }),
    });

    if (!waResponse.ok) {
      console.warn('Failed to register WhatsApp sandbox:', await waResponse.text());
    }

    return {
      phoneNumber: purchaseData.phone_number,
      sid: purchaseData.sid,
    };
  }

  async deprovision(sid: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/IncomingPhoneNumbers/${sid}.json`;
    const authHeader = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio deprovision failed: ${error}`);
    }
  }

  async listNumbers(): Promise<TwilioPhoneNumber[]> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/IncomingPhoneNumbers.json`;
    const authHeader = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;

    const response = await fetch(url, {
      headers: { Authorization: authHeader },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio list failed: ${error}`);
    }

    const data = await response.json() as {
      incoming_phone_numbers: Array<{ sid: string; phone_number: string }>;
    };

    return data.incoming_phone_numbers.map(n => ({
      sid: n.sid,
      phoneNumber: n.phone_number,
    }));
  }
}

// ============================================================================
// WHATSAPP ADAPTER
// ============================================================================

export class WhatsAppAdapter extends EventEmitter implements ChannelAdapter {
  private config: WhatsAppConfig;
  private status: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  private handlers: Array<(msg: Message) => void> = [];
  private socket: WASocket | null = null;
  private dailyLimiter: DailyLimiter;
  private burstLimiter: SlidingWindowLimiter;
  private jidToAgentId: Map<string, string> = new Map();
  private authDir: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000;
  private rotationTimer?: ReturnType<typeof setInterval>;
  private vault?: Vault;
  private provisioner?: TwilioBurnerProvisioner;
  private firewall: ChannelFirewallMiddleware = createFirewallMiddleware('standard');

  constructor(config: WhatsAppConfig, vault?: Vault) {
    super();
    this.config = {
      dailyMessageLimit: 200,
      authDir: join(homedir(), '.agent-zero', 'wa-auth'),
      autoRotate: false,
      rotateIntervalMs: 3600000,
      ...config,
    };
    this.authDir = this.config.authDir!;
    this.dailyLimiter = new DailyLimiter(this.config.dailyMessageLimit!);
    this.burstLimiter = new SlidingWindowLimiter(30, 60000);
    this.vault = vault;

    if (this.config.twilioAccountSid && this.config.twilioAuthToken) {
      this.provisioner = new TwilioBurnerProvisioner(
        this.config.twilioAccountSid,
        this.config.twilioAuthToken,
      );
    }
  }

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') return;

    this.status = 'connecting';

    try {
      await this.createSocket();
      await this.waitForConnection();

      if (this.config.autoRotate && this.provisioner) {
        this.startAutoRotation();
      }
    } catch (err) {
      this.status = 'disconnected';
      throw err;
    }
  }

  /**
   * Create the Baileys socket and wire up event handlers.
   * Separated from connect() so reconnect can call this without waitForConnection.
   */
  private async createSocket(): Promise<void> {
    await mkdir(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
      },
      version,
      logger: silentLogger as any,
      browser: ['Agent Zero', 'Chrome', '10.0'],
      defaultQueryTimeoutMs: 60000,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      void this.handleConnectionUpdate(update);
    });

    this.socket.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        this.handleIncomingMessage(msg as BaileysMessage);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }

    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }

    this.status = 'disconnected';
  }

  async send(content: string, to: string): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.status !== 'connected') throw new Error('WhatsApp not ready');

    if (!this.dailyLimiter.check()) {
      throw new Error(`Daily message limit (${this.config.dailyMessageLimit}) exceeded`);
    }

    if (!this.burstLimiter.check()) {
      throw new Error('Burst rate limit (30/min) exceeded');
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    await this.socket.sendMessage(jid, { text: content });

    this.dailyLimiter.record();
    this.burstLimiter.record();

    const msg: Message = {
      id: randomUUID(),
      kind: 'act',
      from: randomUUID(),
      payload: { content, to: jid, platform: 'whatsapp' },
      timestamp: Date.now(),
    };

    this.emit('send', msg);
  }

  async sendMedia(
    to: string,
    url: string,
    caption?: string,
    type: 'image' | 'video' | 'document' = 'image',
  ): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.status !== 'connected') throw new Error('WhatsApp not ready');

    if (!this.dailyLimiter.check()) {
      throw new Error(`Daily message limit (${this.config.dailyMessageLimit}) exceeded`);
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch media: ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());

    const messageContent: any = { caption };

    if (type === 'image') {
      messageContent.image = buffer;
    } else if (type === 'video') {
      messageContent.video = buffer;
    } else {
      messageContent.document = buffer;
      messageContent.mimetype = 'application/octet-stream';
    }

    await this.socket.sendMessage(jid, messageContent);

    this.dailyLimiter.record();
    this.burstLimiter.record();
  }

  onMessage(handler: (msg: Message) => void): void {
    this.handlers.push(handler);
  }

  getStatus(): 'connected' | 'disconnected' | 'connecting' {
    return this.status;
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrTerminal = (await import('qrcode-terminal')).default ?? await import('qrcode-terminal');
      console.log('\n  Scan this QR code with WhatsApp:\n');
      qrTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isConnectionFailure = statusCode === 515 || statusCode === DisconnectReason.connectionClosed;

      if (isLoggedOut || (isConnectionFailure && this.reconnectAttempts >= 2)) {
        // Auth state is stale — clear it and re-enter QR flow
        console.log('  WhatsApp session expired. Clearing auth for re-pairing...');
        this.status = 'disconnected';

        if (this.socket) {
          this.socket.end(undefined);
          this.socket = null;
        }

        try {
          await rm(this.authDir, { recursive: true, force: true });
        } catch {}

        this.reconnectAttempts = 0;

        // Re-create socket (will show new QR via connection.update)
        // Uses createSocket() to avoid waitForConnection timeout
        setTimeout(() => {
          console.log('  Restarting WhatsApp connection (new QR code)...');
          this.status = 'connecting';
          void this.createSocket().catch((err) => {
            console.log(`  WhatsApp re-auth failed: ${(err as Error).message}`);
            this.status = 'disconnected';
          });
        }, 2000);
      } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        console.log(`  WhatsApp reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})`);

        if (this.socket) {
          this.socket.end(undefined);
          this.socket = null;
        }

        // Reconnect without waitForConnection — connection.update handles status
        setTimeout(() => {
          this.status = 'connecting';
          void this.createSocket().catch((err) => {
            console.log(`  WhatsApp reconnect failed: ${(err as Error).message}`);
            this.status = 'disconnected';
          });
        }, delay);
      } else {
        console.log('  WhatsApp: max reconnection attempts reached.');
        this.status = 'disconnected';
        this.emit('auth:failed');
      }
    } else if (connection === 'open') {
      this.status = 'connected';
      this.reconnectAttempts = 0;
    }
  }

  private handleIncomingMessage(msg: BaileysMessage): void {
    // Allow "Message Yourself" / self-chat messages (for command routing)
    // but skip other fromMe messages (echoes of our own sends)
    const isSelfChat = msg.key.fromMe && msg.key.remoteJid?.endsWith('@s.whatsapp.net')
      && msg.key.remoteJid === `${this.socket?.user?.id?.split(':')[0]}@s.whatsapp.net`;
    if (msg.key.fromMe && !isSelfChat) return;

    const text = this.extractMessageText(msg);
    if (!text) return;

    const firewallResult = this.firewall.process(text, 'channel-bridged');
    if (!firewallResult.safe) {
      this.emit('message:blocked', {
        reason: firewallResult.threats,
        remoteJid: msg.key.remoteJid,
        messageId: msg.key.id,
        timestamp: Date.now(),
      });
      console.log(`WhatsApp: Blocked message from ${msg.key.remoteJid} due to firewall threats:`, firewallResult.threats);
      return;
    }

    const jid = msg.key.remoteJid!;
    const agentId = this.getOrCreateAgentId(jid);
    const timestamp = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp * 1000
      : Number(msg.messageTimestamp) * 1000;

    const axonMsg: Message = {
      id: randomUUID(),
      kind: 'percept',
      from: agentId,
      payload: {
        content: firewallResult.sanitized,
        platform: 'whatsapp',
        remoteJid: jid,
        messageId: msg.key.id,
      },
      timestamp,
    };

    for (const handler of this.handlers) {
      handler(axonMsg);
    }
  }

  private extractMessageText(msg: BaileysMessage): string | null {
    if (!msg.message) return null;

    if (msg.message.conversation) {
      return msg.message.conversation;
    }

    if (msg.message.extendedTextMessage?.text) {
      return msg.message.extendedTextMessage.text;
    }

    if (msg.message.imageMessage?.caption) {
      return msg.message.imageMessage.caption;
    }

    if (msg.message.videoMessage?.caption) {
      return msg.message.videoMessage.caption;
    }

    return null;
  }

  private getOrCreateAgentId(jid: string): string {
    if (!this.jidToAgentId.has(jid)) {
      this.jidToAgentId.set(jid, randomUUID());
    }
    return this.jidToAgentId.get(jid)!;
  }

  private async waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error('Connection timeout'));
      }, 120000);

      const interval = setInterval(() => {
        if (this.status === 'connected') {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 500);
    });
  }

  private startAutoRotation(): void {
    if (!this.provisioner || !this.vault) {
      console.warn('Auto-rotation enabled but Twilio provisioner or vault not available');
      return;
    }

    this.rotationTimer = setInterval(() => {
      void this.rotateIdentity();
    }, this.config.rotateIntervalMs!);
  }

  private async rotateIdentity(): Promise<void> {
    if (!this.provisioner || !this.vault) return;

    try {
      console.log('Starting WhatsApp identity rotation...');

      const newNumber = await this.provisioner.provision();
      console.log(`Provisioned new number: ${newNumber.phoneNumber}`);

      const oldSid = await this.vault.retrieve(`whatsapp:twilio:sid:${this.config.identityId}`);

      await this.disconnect();

      this.config.phoneNumber = newNumber.phoneNumber;
      await this.vault.store(
        `whatsapp:twilio:sid:${this.config.identityId}`,
        newNumber.sid,
      );
      await this.vault.store(
        `whatsapp:phone:${this.config.identityId}`,
        newNumber.phoneNumber,
      );

      await this.connect();

      if (oldSid) {
        try {
          await this.provisioner.deprovision(oldSid);
          console.log('Deprovisioned old number');
        } catch (err) {
          console.warn('Failed to deprovision old number:', err);
        }
      }

      console.log('WhatsApp identity rotation complete');
    } catch (err) {
      console.error('Identity rotation failed:', err);
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createWhatsAppAdapter(config: WhatsAppConfig, vault?: Vault): WhatsAppAdapter {
  return new WhatsAppAdapter(config, vault);
}
