/**
 * SMS Channel Adapter
 *
 * Twilio-backed SMS channel with webhook receiver and signature validation.
 * Uses the same ChannelAdapter interface as WhatsApp.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHmac } from 'crypto';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'eventemitter3';
import type { Message } from '../primitives/types.js';
import type { ChannelAdapter } from './whatsapp.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SmsConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  phoneNumber: string;
  webhookPort?: number;
  /** Public URL for signature validation (e.g. https://agent-zero-agency.fly.dev/sms/inbound) */
  webhookUrl?: string;
}

// ============================================================================
// SMS ADAPTER
// ============================================================================

export class SmsAdapter extends EventEmitter implements ChannelAdapter {
  private config: SmsConfig;
  private status: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  private handlers: Array<(msg: Message) => void> = [];
  private server?: ReturnType<typeof createServer>;

  constructor(config: SmsConfig) {
    super();
    this.config = {
      webhookPort: Number(process.env['SMS_WEBHOOK_PORT']) || 8080,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.status !== 'disconnected') return;
    this.status = 'connecting';

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        if (this.status === 'connecting') {
          this.status = 'disconnected';
          reject(err);
        }
      });

      this.server.listen(this.config.webhookPort, () => {
        this.status = 'connected';
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.status = 'disconnected';
        this.server = undefined;
        resolve();
      });
    });
  }

  async send(content: string, to: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.twilioAccountSid}/Messages.json`;
    const auth = Buffer.from(`${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: this.config.phoneNumber,
        Body: content,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twilio SMS send failed (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  onMessage(handler: (msg: Message) => void): void {
    this.handlers.push(handler);
  }

  getStatus(): 'connected' | 'disconnected' | 'connecting' {
    return this.status;
  }

  // ==========================================================================
  // HTTP WEBHOOK
  // ==========================================================================

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', channel: 'sms' }));
      return;
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/sms/inbound')) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // Validate Twilio signature if webhook URL is configured
      if (this.config.webhookUrl) {
        const signature = req.headers['x-twilio-signature'] as string | undefined;
        if (!signature || !this.validateSignature(signature, body)) {
          res.writeHead(403);
          res.end();
          return;
        }
      }

      const params = new URLSearchParams(body);
      const from = params.get('From');
      const messageBody = params.get('Body');

      if (from && messageBody) {
        const msg: Message = {
          id: randomUUID(),
          kind: 'percept',
          from: randomUUID(),
          payload: {
            content: messageBody,
            platform: 'sms',
            remoteJid: from,
            messageId: params.get('MessageSid') ?? randomUUID(),
          },
          timestamp: Date.now(),
        };

        for (const handler of this.handlers) {
          handler(msg);
        }
      }

      // Return empty TwiML — replies sent via API
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response/>');
    });
  }

  private validateSignature(signature: string, body: string): boolean {
    if (!this.config.webhookUrl) return true;

    // Build sorted param string for Twilio signature validation
    const params = new URLSearchParams(body);
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}${v}`)
      .join('');

    const data = this.config.webhookUrl + sortedParams;
    const expected = createHmac('sha1', this.config.twilioAuthToken)
      .update(data)
      .digest('base64');

    return signature === expected;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSmsAdapter(config: SmsConfig): SmsAdapter {
  return new SmsAdapter(config);
}
