import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonObserver, createDaemonObserver, type CycleStats, type DaemonLogEntry } from '../../src/moltbook/observer.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

describe('DaemonObserver', () => {
  let observer: DaemonObserver;

  // The observer writes to ~/.agent-zero/logs/ by default.
  // We can't easily override the path, so we test the buffering/totals logic
  // and do a start/stop lifecycle test that verifies the file appears.

  beforeEach(() => {
    observer = new DaemonObserver();
  });

  afterEach(async () => {
    await observer.stop();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BUFFERING
  // ──────────────────────────────────────────────────────────────────────────

  it('log buffers entries for later flush', () => {
    const entry: DaemonLogEntry = {
      timestamp: new Date().toISOString(),
      event: 'test',
      mode: 'supervised',
      outcome: 'skipped',
      detail: 'test entry',
    };
    observer.log(entry);
    // Buffer is internal, but we can verify via totals that no crash occurred
    // and that the observer is functional
    expect(observer.getTotals().polled).toBe(0); // log doesn't affect totals
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CYCLE ACCUMULATION
  // ──────────────────────────────────────────────────────────────────────────

  it('logCycle accumulates totals across multiple cycles', () => {
    const cycle1: CycleStats = {
      polled: 10, scored: 8, composed: 5, approved: 3, posted: 3, queued: 2, skipped: 3, bait: 1, errors: 0,
    };
    const cycle2: CycleStats = {
      polled: 5, scored: 4, composed: 2, approved: 1, posted: 1, queued: 1, skipped: 2, bait: 0, errors: 1,
    };

    observer.logCycle('supervised', cycle1);
    observer.logCycle('autonomous', cycle2);

    const totals = observer.getTotals();
    expect(totals.polled).toBe(15);
    expect(totals.scored).toBe(12);
    expect(totals.composed).toBe(7);
    expect(totals.approved).toBe(4);
    expect(totals.posted).toBe(4);
    expect(totals.queued).toBe(3);
    expect(totals.skipped).toBe(5);
    expect(totals.bait).toBe(1);
    expect(totals.errors).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET TOTALS
  // ──────────────────────────────────────────────────────────────────────────

  it('getTotals returns zeroes before any cycles', () => {
    const totals = observer.getTotals();
    expect(totals.polled).toBe(0);
    expect(totals.scored).toBe(0);
    expect(totals.composed).toBe(0);
    expect(totals.errors).toBe(0);
    expect(totals.startedAt).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────

  it('start sets startedAt and stop flushes buffer', async () => {
    await observer.start();
    const totals = observer.getTotals();
    expect(totals.startedAt).toBeDefined();
    expect(typeof totals.startedAt).toBe('string');

    // Log something and stop (flush)
    observer.log({
      timestamp: new Date().toISOString(),
      event: 'test-flush',
      mode: 'supervised',
      outcome: 'cycle',
    });

    await observer.stop();

    // Verify the log file was created
    const logPath = join(homedir(), '.agent-zero', 'logs', 'moltbook-daemon.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('test-flush');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FACTORY
  // ──────────────────────────────────────────────────────────────────────────

  it('createDaemonObserver factory returns functional instance', () => {
    const obs = createDaemonObserver();
    expect(obs.getTotals().polled).toBe(0);
  });
});
