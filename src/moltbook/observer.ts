/**
 * Moltbook Daemon Observer
 *
 * Structured logging and metrics for the engagement daemon.
 * Writes JSONL to ~/.agent-zero/logs/moltbook-daemon.jsonl
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ApprovalMode } from './approvalGate.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DaemonLogEntry {
  timestamp: string;
  event: string;
  threadId?: string;
  score?: number;
  confidence?: number;
  mode: ApprovalMode;
  outcome: 'posted' | 'queued' | 'skipped' | 'bait' | 'error' | 'cycle' | 'start' | 'stop';
  detail?: string;
}

export interface CycleStats {
  polled: number;
  scored: number;
  composed: number;
  approved: number;
  posted: number;
  queued: number;
  skipped: number;
  bait: number;
  errors: number;
}

// ============================================================================
// OBSERVER
// ============================================================================

const LOG_DIR = join(homedir(), '.agent-zero', 'logs');
const LOG_PATH = join(LOG_DIR, 'moltbook-daemon.jsonl');

export class DaemonObserver {
  private buffer: string[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;
  private totals: CycleStats = { polled: 0, scored: 0, composed: 0, approved: 0, posted: 0, queued: 0, skipped: 0, bait: 0, errors: 0 };
  private startedAt?: string;

  async start(): Promise<void> {
    await mkdir(LOG_DIR, { recursive: true });
    this.startedAt = new Date().toISOString();
    this.flushTimer = setInterval(() => void this.flush(), 5_000);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  log(entry: DaemonLogEntry): void {
    this.buffer.push(JSON.stringify(entry));
  }

  logCycle(mode: ApprovalMode, stats: CycleStats): void {
    this.totals.polled += stats.polled;
    this.totals.scored += stats.scored;
    this.totals.composed += stats.composed;
    this.totals.approved += stats.approved;
    this.totals.posted += stats.posted;
    this.totals.queued += stats.queued;
    this.totals.skipped += stats.skipped;
    this.totals.bait += stats.bait;
    this.totals.errors += stats.errors;

    this.log({
      timestamp: new Date().toISOString(),
      event: 'cycle_complete',
      mode,
      outcome: 'cycle',
      detail: JSON.stringify(stats),
    });
  }

  getTotals(): CycleStats & { startedAt?: string } {
    return { ...this.totals, startedAt: this.startedAt };
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.splice(0).join('\n') + '\n';
    try {
      await appendFile(LOG_PATH, lines);
    } catch {
      // If we can't write logs, don't crash the daemon
    }
  }
}

export function createDaemonObserver(): DaemonObserver {
  return new DaemonObserver();
}
