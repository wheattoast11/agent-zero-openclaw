/**
 * Summary Scheduler
 *
 * Configurable push notifications via WhatsApp.
 * - daily: 09:00
 * - twice-daily: 09:00 and 18:00
 * - on-demand: only via /summary command
 */

import type { WhatsAppAdapter } from '../channels/whatsapp.js';
import { collectSummaryData, formatWhatsApp, type SummarySources } from './summaryGenerator.js';

// ============================================================================
// TYPES
// ============================================================================

export type SummarySchedule = 'daily' | 'twice-daily' | 'on-demand';

export interface SchedulerConfig {
  schedule: SummarySchedule;
  userJid: string;
  whatsApp: WhatsAppAdapter;
  sources: SummarySources;
  /** Hours to send (24h format). Default: [9] for daily, [9,18] for twice-daily */
  sendHours?: number[];
}

// ============================================================================
// SCHEDULER
// ============================================================================

export class SummaryScheduler {
  private config: SchedulerConfig;
  private checkTimer?: ReturnType<typeof setInterval>;
  private lastSentHour = -1;
  private lastSentDate = '';
  private sendHours: number[];

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.sendHours = config.sendHours ?? (config.schedule === 'twice-daily' ? [9, 18] : [9]);
  }

  start(): void {
    if (this.config.schedule === 'on-demand') return;

    // Check every minute
    this.checkTimer = setInterval(() => {
      void this.checkAndSend();
    }, 60_000);

    // Don't keep process alive just for scheduler
    if (this.checkTimer.unref) this.checkTimer.unref();
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  async sendNow(): Promise<void> {
    const data = await collectSummaryData(this.config.sources);
    const text = formatWhatsApp(data);
    await this.config.whatsApp.send(text, this.config.userJid);
  }

  private async checkAndSend(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const dateStr = now.toISOString().slice(0, 10);

    // Only send once per hour per date
    const key = `${dateStr}:${hour}`;
    if (this.lastSentDate === dateStr && this.lastSentHour === hour) return;

    if (this.sendHours.includes(hour)) {
      try {
        await this.sendNow();
        this.lastSentHour = hour;
        this.lastSentDate = dateStr;
      } catch (err) {
        console.error('Summary send failed:', (err as Error).message);
      }
    }
  }
}

export function createSummaryScheduler(config: SchedulerConfig): SummaryScheduler {
  return new SummaryScheduler(config);
}
