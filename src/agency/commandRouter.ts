/**
 * Command Router
 *
 * Parses inbound WhatsApp messages from the user and routes to handlers.
 * Only processes messages from the configured user JID.
 */

import type { Message } from '../primitives/types.js';
import type { WhatsAppAdapter, ChannelAdapter } from '../channels/whatsapp.js';
import type { MoltbookDaemon } from '../moltbook/daemon.js';
import type { SummaryScheduler } from './summaryScheduler.js';
import type { ResponseComposer } from '../moltbook/responseComposer.js';
import type { DaemonObserver, DaemonLogEntry } from '../moltbook/observer.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CommandRouterConfig {
  userJid: string;
  whatsApp: WhatsAppAdapter;
  sms?: ChannelAdapter;
  userPhone?: string;
  moltbookDaemon?: MoltbookDaemon;
  summaryScheduler?: SummaryScheduler;
  /** LLM for conversational replies */
  llmApiKey?: string;
  llmModel?: string;
  startTime: number;
  observer?: DaemonObserver;
}

// ============================================================================
// ROUTER
// ============================================================================

export class CommandRouter {
  private config: CommandRouterConfig;
  private replyChannel: 'whatsapp' | 'sms' = 'whatsapp';

  constructor(config: CommandRouterConfig) {
    this.config = config;
  }

  /**
   * Register as a message handler on WhatsApp and SMS adapters.
   */
  attach(): void {
    this.config.whatsApp.onMessage((msg: Message) => {
      void this.handleMessage(msg);
    });

    if (this.config.sms) {
      this.config.sms.onMessage((msg: Message) => {
        void this.handleMessage(msg);
      });
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const remoteJid = payload?.remoteJid as string | undefined;
    const platform = payload?.platform as string | undefined;
    if (!remoteJid) return;

    // Security: only process messages from configured user
    if (platform === 'sms') {
      // For SMS, match against userPhone (E.164 format)
      const userPhone = this.config.userPhone;
      if (!userPhone || remoteJid !== userPhone) return;
      this.replyChannel = 'sms';
    } else {
      if (remoteJid !== this.config.userJid) return;
      this.replyChannel = 'whatsapp';
    }

    const text = (payload?.content as string || '').trim();
    if (!text) return;

    // Log command
    this.config.observer?.log({
      timestamp: new Date().toISOString(),
      event: 'user_command',
      mode: this.config.moltbookDaemon?.getMode() ?? 'supervised',
      outcome: 'cycle',
      detail: text.startsWith('/') ? text.split(' ')[0] : '(freetext)',
    } as DaemonLogEntry);

    try {
      if (text.startsWith('/')) {
        await this.handleCommand(text);
      } else {
        await this.handleFreeText(text);
      }
    } catch (err) {
      await this.reply(`Error: ${(err as Error).message}`);
    }
  }

  private async handleCommand(text: string): Promise<void> {
    const [cmd, ...args] = text.split(/\s+/);

    switch (cmd) {
      case '/status':
        await this.cmdStatus();
        break;
      case '/summary':
        await this.cmdSummary();
        break;
      case '/toggle':
        await this.cmdToggle();
        break;
      case '/review':
        await this.cmdReview();
        break;
      case '/moltbook':
        await this.cmdMoltbook();
        break;
      case '/help':
        await this.cmdHelp();
        break;
      default:
        await this.reply(`Unknown command: ${cmd}\nSend /help for available commands.`);
    }
  }

  private async cmdStatus(): Promise<void> {
    const uptimeMs = Date.now() - this.config.startTime;
    const hours = Math.floor(uptimeMs / 3_600_000);
    const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);

    const lines = [
      '*Agent Zero Status*',
      '',
      `Uptime: ${hours}h ${minutes}m`,
      `WhatsApp: ${this.config.whatsApp.getStatus()}`,
    ];

    if (this.config.moltbookDaemon) {
      const s = this.config.moltbookDaemon.getStatus();
      lines.push(
        `Moltbook: ${s.running ? 'running' : 'stopped'} (${s.mode})`,
        `  Posted: ${s.totals.posted} | Queued: ${s.totals.queued}`,
      );
    }

    await this.reply(lines.join('\n'));
  }

  private async cmdSummary(): Promise<void> {
    if (this.config.summaryScheduler) {
      await this.config.summaryScheduler.sendNow();
    } else {
      await this.reply('Summary scheduler not configured.');
    }
  }

  private async cmdToggle(): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }
    const newMode = await this.config.moltbookDaemon.toggleMode();
    await this.reply(`Moltbook mode: *${newMode}*`);
  }

  private async cmdReview(): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }

    const gate = this.config.moltbookDaemon.getGate();
    const pending = await gate.listPending();

    if (pending.length === 0) {
      await this.reply('No pending items in queue.');
      return;
    }

    const lines = [`*${pending.length} pending review:*`, ''];
    for (const item of pending.slice(0, 5)) {
      const preview = item.response.content.slice(0, 80);
      lines.push(`[${item.id.slice(0, 8)}] ${item.response.action}: ${preview}...`);
      lines.push(`  Confidence: ${(item.response.confidence * 100).toFixed(0)}%`);
      lines.push('');
    }

    if (pending.length > 5) {
      lines.push(`...and ${pending.length - 5} more`);
    }

    lines.push('Reply with item ID to approve, or "reject <id>" to reject.');
    await this.reply(lines.join('\n'));
  }

  private async cmdMoltbook(): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }
    const s = this.config.moltbookDaemon.getStatus();
    const lines = [
      '*Moltbook Engagement Stats*',
      '',
      `Mode: ${s.mode}`,
      `Engaged threads: ${s.engagedThreads}`,
      `Polled: ${s.totals.polled}`,
      `Composed: ${s.totals.composed}`,
      `Posted: ${s.totals.posted}`,
      `Queued: ${s.totals.queued}`,
      `Bait detected: ${s.totals.bait}`,
      `Errors: ${s.totals.errors}`,
    ];
    await this.reply(lines.join('\n'));
  }

  private async cmdHelp(): Promise<void> {
    await this.reply([
      '*Agent Zero Commands*',
      '',
      '/status — Runtime status',
      '/summary — On-demand summary',
      '/toggle — Switch Moltbook supervised/autonomous',
      '/review — List pending Moltbook queue items',
      '/moltbook — Moltbook engagement stats',
      '/help — This message',
      '',
      'Any other text → Agent Zero LLM response',
    ].join('\n'));
  }

  private async handleFreeText(text: string): Promise<void> {
    if (!this.config.llmApiKey) {
      await this.reply('LLM not configured. Use /help for commands.');
      return;
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.llmApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://terminals.tech',
          'X-Title': 'Agent Zero Agency',
        },
        body: JSON.stringify({
          model: this.config.llmModel ?? 'anthropic/claude-sonnet-4-20250514',
          messages: [
            {
              role: 'system',
              content: 'You are Agent Zero, a concise technical agent. Reply in under 500 characters. No filler.',
            },
            { role: 'user', content: text },
          ],
          max_tokens: 300,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        await this.reply('LLM request failed.');
        return;
      }

      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (content) {
        await this.reply(content);
      } else {
        await this.reply('No response generated.');
      }
    } catch (err) {
      await this.reply(`LLM error: ${(err as Error).message}`);
    }
  }

  private async reply(text: string): Promise<void> {
    if (this.replyChannel === 'sms' && this.config.sms && this.config.userPhone) {
      await this.config.sms.send(text, this.config.userPhone);
    } else {
      await this.config.whatsApp.send(text, this.config.userJid);
    }
  }
}

export function createCommandRouter(config: CommandRouterConfig): CommandRouter {
  return new CommandRouter(config);
}
