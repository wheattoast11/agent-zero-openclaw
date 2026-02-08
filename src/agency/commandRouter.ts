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
import type { QueuedResponse } from '../moltbook/approvalGate.js';
import type { AgencyRuntime } from './runtime.js';

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
  /** Agency runtime reference for pause/resume */
  agencyRuntime?: AgencyRuntime;
}

// ============================================================================
// ROUTER
// ============================================================================

export class CommandRouter {
  private config: CommandRouterConfig;
  private replyChannel: 'whatsapp' | 'sms' = 'whatsapp';
  private reviewSession: Map<number, QueuedResponse> = new Map();
  private reviewSessionExpiry = 0;

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
      if (!userPhone || remoteJid !== userPhone) {
        console.log(`[SMS] Ignoring message from ${remoteJid} (expected ${userPhone ?? 'not configured'})`);
        return;
      }
      this.replyChannel = 'sms';
    } else {
      if (remoteJid !== this.config.userJid) return;
      this.replyChannel = 'whatsapp';
    }

    const text = (payload?.content as string || '').trim();
    if (!text) return;

    console.log(`[CMD] Received (${platform ?? 'whatsapp'}): ${text.slice(0, 50)}`);

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
      } else if (this.isApprovalInput(text)) {
        await this.handleApproval(text);
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
      case '/pause':
        await this.cmdPause(args.join(' ').trim());
        break;
      case '/resume':
        await this.cmdResume(args.join(' ').trim());
        break;
      case '/approve':
        await this.cmdApprove(args.join(' ').trim());
        break;
      case '/reject':
        await this.cmdReject(args.join(' ').trim());
        break;
      case '/edit':
        await this.cmdEdit(args);
        break;
      case '/queue':
        await this.cmdQueue();
        break;
      case '/plan':
        await this.cmdPlan(args.join(' ').trim());
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

    // Show pause state if runtime is available
    if (this.config.agencyRuntime) {
      const pauseMap = this.config.agencyRuntime.getPauseState();
      const pausedSystems: string[] = [];
      for (const [name, paused] of pauseMap) {
        if (paused) pausedSystems.push(name);
      }
      if (pausedSystems.length > 0) {
        lines.push(`Paused: ${pausedSystems.join(', ')}`);
      }
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

    // Build numbered review session
    this.reviewSession.clear();
    pending.forEach((item, i) => this.reviewSession.set(i + 1, item));
    this.reviewSessionExpiry = Date.now() + 30 * 60 * 1000; // 30min

    const lines = [`*${pending.length} pending:*`, ''];
    for (const [num, item] of this.reviewSession) {
      const pct = `${(item.response.confidence * 100).toFixed(0)}%`;
      const label = item.label ?? item.response.action;
      const preview = (item.response.content ?? '').slice(0, 80);
      lines.push(`*${num}.* ${label} (${pct})`);
      lines.push(`  ${preview}${preview.length >= 80 ? '...' : ''}`);
      lines.push('');
    }

    lines.push('Reply: 1 3 5 / reject 2 / approve all');
    await this.reply(lines.join('\n'));
  }

  private isApprovalInput(text: string): boolean {
    if (this.reviewSession.size === 0 || Date.now() > this.reviewSessionExpiry) return false;
    const lower = text.toLowerCase().trim();
    if (lower === 'approve all' || lower === 'all') return true;
    if (/^reject\s+[\d\s,]+$/.test(lower)) return true;
    // Pure number patterns: "1 3 5", "1,3,5", "1, 3, 5", single "3"
    if (/^[\d\s,]+$/.test(lower) && /\d/.test(lower)) return true;
    return false;
  }

  private async handleApproval(text: string): Promise<void> {
    if (!this.config.moltbookDaemon) return;

    const gate = this.config.moltbookDaemon.getGate();
    const lower = text.toLowerCase().trim();
    const results: string[] = [];

    if (lower === 'approve all' || lower === 'all') {
      // Approve everything in session
      for (const [num, item] of this.reviewSession) {
        try {
          const response = await gate.approve(item.id);
          if (response) {
            await this.config.moltbookDaemon.executeApproved(response);
            results.push(`#${num}: posted (${item.response.action})`);
          }
        } catch (err) {
          results.push(`#${num}: error — ${(err as Error).message}`);
        }
      }
      this.reviewSession.clear();
    } else if (lower.startsWith('reject')) {
      // Reject specific numbers
      const nums = lower.replace('reject', '').match(/\d+/g)?.map(Number) ?? [];
      for (const num of nums) {
        const item = this.reviewSession.get(num);
        if (!item) { results.push(`#${num}: not found`); continue; }
        await gate.reject(item.id);
        this.reviewSession.delete(num);
        results.push(`#${num}: rejected`);
      }
    } else {
      // Approve specific numbers
      const nums = text.match(/\d+/g)?.map(Number) ?? [];
      for (const num of nums) {
        const item = this.reviewSession.get(num);
        if (!item) { results.push(`#${num}: not found`); continue; }
        try {
          const response = await gate.approve(item.id);
          if (response) {
            await this.config.moltbookDaemon.executeApproved(response);
            results.push(`#${num}: posted (${item.response.action})`);
          }
        } catch (err) {
          results.push(`#${num}: error — ${(err as Error).message}`);
        }
        this.reviewSession.delete(num);
      }
    }

    // Cleanup approved/rejected files
    await gate.cleanup();

    const remaining = this.reviewSession.size;
    if (remaining > 0) {
      results.push(`${remaining} item${remaining > 1 ? 's' : ''} remaining.`);
    } else {
      results.push('Queue clear.');
    }

    await this.reply(results.join('\n'));
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

  private async cmdPause(subsystem: string): Promise<void> {
    if (!this.config.agencyRuntime) {
      await this.reply('Agency runtime not available.');
      return;
    }
    if (!subsystem) {
      await this.reply('Usage: /pause <moltbook|summary|whatsapp|sms|all>');
      return;
    }
    const result = this.config.agencyRuntime.pause(subsystem);
    const lines = [
      `Paused: *${subsystem}*`,
      '',
      `Active: ${result.active.length > 0 ? result.active.join(', ') : 'none'}`,
      `Paused: ${result.paused.length > 0 ? result.paused.join(', ') : 'none'}`,
    ];
    await this.reply(lines.join('\n'));
  }

  private async cmdResume(subsystem: string): Promise<void> {
    if (!this.config.agencyRuntime) {
      await this.reply('Agency runtime not available.');
      return;
    }
    if (!subsystem) {
      await this.reply('Usage: /resume <moltbook|summary|whatsapp|sms|all>');
      return;
    }
    const result = this.config.agencyRuntime.resume(subsystem);
    const lines = [
      `Resumed: *${subsystem}*`,
      '',
      `Active: ${result.active.length > 0 ? result.active.join(', ') : 'none'}`,
      `Paused: ${result.paused.length > 0 ? result.paused.join(', ') : 'none'}`,
    ];
    await this.reply(lines.join('\n'));
  }

  private async cmdApprove(arg: string): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }
    if (!arg) {
      await this.reply('Usage: /approve <id> or /approve all');
      return;
    }

    const gate = this.config.moltbookDaemon.getGate();

    if (arg.toLowerCase() === 'all') {
      const pending = await gate.listPending();
      if (pending.length === 0) {
        await this.reply('No pending items.');
        return;
      }
      let approved = 0;
      for (const item of pending) {
        const response = await gate.approve(item.id);
        if (response) {
          await this.config.moltbookDaemon.executeApproved(response);
          approved++;
        }
      }
      await gate.cleanup();
      await this.reply(`Approved and posted ${approved} item${approved !== 1 ? 's' : ''}.`);
      return;
    }

    const response = await gate.approve(arg);
    if (response) {
      await this.config.moltbookDaemon.executeApproved(response);
      await gate.cleanup();
      await this.reply(`Approved and posted: ${arg.slice(0, 8)}...`);
    } else {
      await this.reply(`Item not found: ${arg.slice(0, 8)}...`);
    }
  }

  private async cmdReject(arg: string): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }
    if (!arg) {
      await this.reply('Usage: /reject <id> [reason]');
      return;
    }

    const gate = this.config.moltbookDaemon.getGate();
    // First token is ID, rest is reason
    const parts = arg.split(/\s+/);
    const itemId = parts[0];
    const reason = parts.slice(1).join(' ') || undefined;

    const result = await gate.reject(itemId);
    if (result) {
      await this.reply(`Rejected: ${itemId.slice(0, 8)}...${reason ? ` (${reason})` : ''}`);
    } else {
      await this.reply(`Item not found: ${itemId.slice(0, 8)}...`);
    }
  }

  private async cmdEdit(args: string[]): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }
    if (args.length < 2) {
      await this.reply('Usage: /edit <id> <new content>');
      return;
    }

    const gate = this.config.moltbookDaemon.getGate();
    const itemId = args[0];
    const newContent = args.slice(1).join(' ');

    const result = await gate.editAndApprove(itemId, newContent);
    if (result) {
      // Execute the edited+approved response
      const pending = await gate.listPending();
      // Item was already approved in editAndApprove, retrieve it via the file
      await this.reply(`Edited and approved: ${itemId.slice(0, 8)}...`);
    } else {
      await this.reply(`Item not found: ${itemId.slice(0, 8)}...`);
    }
  }

  private async cmdQueue(): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }

    const gate = this.config.moltbookDaemon.getGate();
    const details = await gate.getQueueDetails();

    if (details.length === 0) {
      await this.reply('Queue is empty.');
      return;
    }

    const lines = [`*${details.length} pending:*`, ''];
    for (const item of details) {
      const pct = `${(item.confidence * 100).toFixed(0)}%`;
      lines.push(`*${item.id.slice(0, 8)}* (${pct})`);
      lines.push(`  ${item.preview}${item.preview.length >= 100 ? '...' : ''}`);
      lines.push('');
    }
    await this.reply(lines.join('\n'));
  }

  private async cmdPlan(topic?: string): Promise<void> {
    if (!this.config.moltbookDaemon) {
      await this.reply('Moltbook daemon not running.');
      return;
    }

    await this.reply('Generating engagement plan...');

    try {
      const plans = await this.config.moltbookDaemon.generatePlan(topic || undefined);

      if (plans.length === 0) {
        await this.reply('No engagement targets found.');
        return;
      }

      const lines = [`*Engagement Plan${topic ? ` (${topic})` : ''}*`, ''];
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        lines.push(`*${i + 1}.* ${p.proposedAction} on "${p.targetThread.title.slice(0, 50)}"`);
        lines.push(`   Confidence: ${(p.confidence * 100).toFixed(0)}%`);
        lines.push(`   Rationale: ${p.rationale}`);
        lines.push(`   Draft: ${p.draftContent.slice(0, 120)}${p.draftContent.length > 120 ? '...' : ''}`);
        lines.push('');
      }
      await this.reply(lines.join('\n'));
    } catch (err) {
      await this.reply(`Plan generation failed: ${(err as Error).message}`);
    }
  }

  private async cmdHelp(): Promise<void> {
    await this.reply([
      '*Agent Zero Commands*',
      '',
      '/status — Runtime status',
      '/summary — On-demand summary',
      '/toggle — Switch Moltbook supervised/autonomous',
      '/review — Review queue (1 3 5 / reject 2 / approve all)',
      '/moltbook — Moltbook engagement stats',
      '/pause <subsystem> — Pause subsystem',
      '/resume <subsystem> — Resume subsystem',
      '/queue — List pending queue items',
      '/approve <id|all> — Approve queued item(s)',
      '/reject <id> [reason] — Reject queued item',
      '/edit <id> <content> — Edit and approve item',
      '/plan [topic] — Generate engagement plan',
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
    try {
      if (this.replyChannel === 'sms' && this.config.sms && this.config.userPhone) {
        console.log(`[CMD] Replying via SMS to ${this.config.userPhone}`);
        await this.config.sms.send(text, this.config.userPhone);
      } else {
        console.log(`[CMD] Replying via WhatsApp to ${this.config.userJid}`);
        await this.config.whatsApp.send(text, this.config.userJid);
      }
      console.log('[CMD] Reply sent');
    } catch (err) {
      console.error(`[CMD] Reply failed: ${(err as Error).message}`);
    }
  }
}

export function createCommandRouter(config: CommandRouterConfig): CommandRouter {
  return new CommandRouter(config);
}
