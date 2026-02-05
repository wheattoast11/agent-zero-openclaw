import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalGate } from '../../src/moltbook/approvalGate.js';
import { Vault } from '../../src/security/vault.js';
import type { ComposedResponse } from '../../src/moltbook/responseComposer.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeResponse(overrides: Partial<ComposedResponse> = {}): ComposedResponse {
  return {
    threadId: 'thread-1',
    content: 'Interesting perspective on coherence dynamics.',
    confidence: 0.85,
    reasoning: 'High alignment with identity vectors',
    action: 'comment',
    ...overrides,
  };
}

describe('ApprovalGate', () => {
  let tmpDir: string;
  let queueDir: string;
  let vault: Vault;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'approval-gate-test-'));
    queueDir = join(tmpDir, 'queue');
    process.env['VAULT_DIR'] = tmpDir;
    vault = await Vault.create('test-pass');
  });

  afterEach(() => {
    delete process.env['VAULT_DIR'];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SUPERVISED MODE
  // ──────────────────────────────────────────────────────────────────────────

  it('supervised mode queues everything', async () => {
    const gate = new ApprovalGate(vault, { mode: 'supervised', queueDir });
    const result = await gate.evaluate(makeResponse({ confidence: 0.99 }));
    expect(result.decision).toBe('queue');
    expect(result.queued).toBeDefined();
    expect(result.queued!.status).toBe('pending');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AUTONOMOUS MODE
  // ──────────────────────────────────────────────────────────────────────────

  it('autonomous mode auto-approves high confidence', async () => {
    const gate = new ApprovalGate(vault, { mode: 'autonomous', queueDir, autoApproveThreshold: 0.8 });
    const result = await gate.evaluate(makeResponse({ confidence: 0.9 }));
    expect(result.decision).toBe('approve');
    expect(result.queued).toBeUndefined();
  });

  it('autonomous mode queues low confidence', async () => {
    const gate = new ApprovalGate(vault, { mode: 'autonomous', queueDir, autoApproveThreshold: 0.8 });
    const result = await gate.evaluate(makeResponse({ confidence: 0.5 }));
    expect(result.decision).toBe('queue');
    expect(result.queued).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SKIP ACTION
  // ──────────────────────────────────────────────────────────────────────────

  it('skip action always rejects', async () => {
    const gate = new ApprovalGate(vault, { mode: 'autonomous', queueDir });
    const result = await gate.evaluate(makeResponse({ action: 'skip', confidence: 1.0 }));
    expect(result.decision).toBe('reject');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // QUEUE OPERATIONS
  // ──────────────────────────────────────────────────────────────────────────

  it('listPending returns pending items sorted by date', async () => {
    const gate = new ApprovalGate(vault, { mode: 'supervised', queueDir });

    await gate.enqueue(makeResponse({ threadId: 'first' }));
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await gate.enqueue(makeResponse({ threadId: 'second' }));

    const pending = await gate.listPending();
    expect(pending).toHaveLength(2);
    // Sorted ascending by queuedAt
    expect(pending[0].response.threadId).toBe('first');
    expect(pending[1].response.threadId).toBe('second');
  });

  it('approve changes status and returns response', async () => {
    const gate = new ApprovalGate(vault, { mode: 'supervised', queueDir });
    const queued = await gate.enqueue(makeResponse({ content: 'Test content' }));

    const response = await gate.approve(queued.id);
    expect(response).not.toBeNull();
    expect(response!.content).toBe('Test content');

    // Item should no longer be pending
    const pending = await gate.listPending();
    expect(pending.filter(p => p.id === queued.id)).toHaveLength(0);
  });

  it('reject removes the file', async () => {
    const gate = new ApprovalGate(vault, { mode: 'supervised', queueDir });
    const queued = await gate.enqueue(makeResponse());

    const result = await gate.reject(queued.id);
    expect(result).toBe(true);

    const pending = await gate.listPending();
    expect(pending).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // MODE TOGGLING
  // ──────────────────────────────────────────────────────────────────────────

  it('toggleMode flips and persists to vault', async () => {
    const gate = new ApprovalGate(vault, { mode: 'supervised', queueDir });
    expect(gate.getMode()).toBe('supervised');

    const next = await gate.toggleMode();
    expect(next).toBe('autonomous');
    expect(gate.getMode()).toBe('autonomous');

    // Verify persisted in vault
    const stored = await vault.retrieve('moltbook:daemon:mode');
    expect(stored).toBe('autonomous');

    // Toggle back
    const next2 = await gate.toggleMode();
    expect(next2).toBe('supervised');
  });

  it('loadMode reads from vault', async () => {
    await vault.store('moltbook:daemon:mode', 'autonomous');
    const gate = new ApprovalGate(vault, { mode: 'supervised', queueDir });
    const mode = await gate.loadMode();
    expect(mode).toBe('autonomous');
    expect(gate.getMode()).toBe('autonomous');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STATS
  // ──────────────────────────────────────────────────────────────────────────

  it('tracks stats correctly', async () => {
    const gate = new ApprovalGate(vault, { mode: 'autonomous', queueDir, autoApproveThreshold: 0.8 });

    await gate.evaluate(makeResponse({ confidence: 0.9 }));  // approve
    await gate.evaluate(makeResponse({ confidence: 0.5 }));  // queue
    await gate.evaluate(makeResponse({ action: 'skip' }));   // reject

    const stats = gate.getStats();
    expect(stats.approved).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.mode).toBe('autonomous');
  });
});
