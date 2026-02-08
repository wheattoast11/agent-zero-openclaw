/**
 * Approval Gate
 *
 * Controls whether composed responses auto-post or queue for human review.
 * Supports supervised (all queued) and autonomous (confidence-gated) modes.
 */

import { readFile, writeFile, readdir, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { ComposedResponse } from './responseComposer.js';
import type { Vault } from '../security/vault.js';

// ============================================================================
// TYPES
// ============================================================================

export type ApprovalMode = 'supervised' | 'autonomous';

export interface ApprovalConfig {
  mode: ApprovalMode;
  /** Confidence threshold for auto-post in autonomous mode (default: 0.8) */
  autoApproveThreshold: number;
  /** Directory for pending responses (default: ~/.agent-zero/moltbook-queue/) */
  queueDir: string;
  /** Optional webhook URL for notifications */
  webhookUrl?: string;
}

export interface QueuedResponse {
  id: string;
  response: ComposedResponse;
  queuedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  label?: string;
}

export type GateDecision = 'approve' | 'queue' | 'reject';

// ============================================================================
// APPROVAL GATE
// ============================================================================

const DEFAULT_QUEUE_DIR = join(homedir(), '.agent-zero', 'moltbook-queue');
const MODE_VAULT_KEY = 'moltbook:daemon:mode';

export class ApprovalGate {
  private config: ApprovalConfig;
  private vault: Vault;
  private stats = { approved: 0, queued: 0, rejected: 0 };

  constructor(vault: Vault, config?: Partial<ApprovalConfig>) {
    this.vault = vault;
    this.config = {
      mode: 'supervised',
      autoApproveThreshold: 0.8,
      queueDir: DEFAULT_QUEUE_DIR,
      ...config,
    };
  }

  /**
   * Load mode from vault (allows runtime toggling without restart).
   */
  async loadMode(): Promise<ApprovalMode> {
    const stored = await this.vault.retrieve(MODE_VAULT_KEY);
    if (stored === 'supervised' || stored === 'autonomous') {
      this.config.mode = stored;
    }
    return this.config.mode;
  }

  /**
   * Toggle between supervised and autonomous mode. Persists to vault.
   */
  async setMode(mode: ApprovalMode): Promise<void> {
    this.config.mode = mode;
    await this.vault.store(MODE_VAULT_KEY, mode);
  }

  /**
   * Toggle mode (flip between supervised/autonomous).
   */
  async toggleMode(): Promise<ApprovalMode> {
    const next: ApprovalMode = this.config.mode === 'supervised' ? 'autonomous' : 'supervised';
    await this.setMode(next);
    return next;
  }

  getMode(): ApprovalMode {
    return this.config.mode;
  }

  /**
   * Evaluate a composed response. Returns decision and queued item if applicable.
   */
  async evaluate(response: ComposedResponse): Promise<{ decision: GateDecision; queued?: QueuedResponse }> {
    // Skip and rejected actions never post
    if (response.action === 'skip') {
      this.stats.rejected++;
      return { decision: 'reject' };
    }

    // In autonomous mode, high-confidence responses auto-approve
    if (this.config.mode === 'autonomous') {
      if (response.confidence >= this.config.autoApproveThreshold) {
        this.stats.approved++;
        return { decision: 'approve' };
      }
    }

    // Everything else gets queued
    const queued = await this.enqueue(response);
    this.stats.queued++;
    return { decision: 'queue', queued };
  }

  /**
   * Write a response to the review queue directory.
   */
  async enqueue(response: ComposedResponse, label?: string): Promise<QueuedResponse> {
    await mkdir(this.config.queueDir, { recursive: true });

    const item: QueuedResponse = {
      id: randomUUID(),
      response,
      queuedAt: new Date().toISOString(),
      status: 'pending',
      ...(label ? { label } : {}),
    };

    const filePath = join(this.config.queueDir, `${item.id}.json`);
    await writeFile(filePath, JSON.stringify(item, null, 2));

    // Notify webhook if configured
    if (this.config.webhookUrl) {
      this.notifyWebhook(item).catch(() => {}); // fire and forget
    }

    return item;
  }

  /**
   * List all pending items in the queue.
   */
  async listPending(): Promise<QueuedResponse[]> {
    try {
      const files = await readdir(this.config.queueDir);
      const items: QueuedResponse[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.config.queueDir, file), 'utf-8');
          const item = JSON.parse(raw) as QueuedResponse;
          if (item.status === 'pending') items.push(item);
        } catch {
          // skip corrupted files
        }
      }

      return items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    } catch {
      return [];
    }
  }

  /**
   * Approve a queued item by ID. Returns the response for posting.
   */
  async approve(id: string): Promise<ComposedResponse | null> {
    const filePath = join(this.config.queueDir, `${id}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const item = JSON.parse(raw) as QueuedResponse;
      item.status = 'approved';
      await writeFile(filePath, JSON.stringify(item, null, 2));
      this.stats.approved++;
      return item.response;
    } catch {
      return null;
    }
  }

  /**
   * Reject a queued item by ID.
   */
  async reject(id: string): Promise<boolean> {
    const filePath = join(this.config.queueDir, `${id}.json`);
    try {
      await unlink(filePath);
      this.stats.rejected++;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove processed (approved/rejected) items from queue.
   */
  async cleanup(): Promise<number> {
    let removed = 0;
    try {
      const files = await readdir(this.config.queueDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.config.queueDir, file), 'utf-8');
          const item = JSON.parse(raw) as QueuedResponse;
          if (item.status !== 'pending') {
            await unlink(join(this.config.queueDir, file));
            removed++;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // queue dir doesn't exist
    }
    return removed;
  }

  /**
   * Get detailed queue info with previews for each pending item.
   */
  async getQueueDetails(): Promise<Array<{
    id: string;
    threadId: string;
    content: string;
    confidence: number;
    createdAt: number;
    preview: string;
  }>> {
    const pending = await this.listPending();
    return pending.map(item => ({
      id: item.id,
      threadId: item.response.threadId,
      content: item.response.content,
      confidence: item.response.confidence,
      createdAt: new Date(item.queuedAt).getTime(),
      preview: (item.response.content ?? '').slice(0, 100),
    }));
  }

  /**
   * Approve a specific item by its ID. Returns true if found and approved.
   */
  async approveById(itemId: string, feedback?: string): Promise<boolean> {
    const response = await this.approve(itemId);
    return response !== null;
  }

  /**
   * Reject a specific item by its ID with optional reason.
   */
  async rejectById(itemId: string, reason?: string): Promise<boolean> {
    return this.reject(itemId);
  }

  /**
   * Edit the content of a queued item and approve it.
   */
  async editAndApprove(itemId: string, editedContent: string): Promise<boolean> {
    const filePath = join(this.config.queueDir, `${itemId}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const item = JSON.parse(raw) as QueuedResponse;
      item.response.content = editedContent;
      item.status = 'approved';
      await writeFile(filePath, JSON.stringify(item, null, 2));
      this.stats.approved++;
      return true;
    } catch {
      return false;
    }
  }

  getStats() {
    return { ...this.stats, mode: this.config.mode };
  }

  private async notifyWebhook(item: QueuedResponse): Promise<void> {
    if (!this.config.webhookUrl) return;
    await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'moltbook:review_needed',
        item: {
          id: item.id,
          threadId: item.response.threadId,
          action: item.response.action,
          confidence: item.response.confidence,
          reasoning: item.response.reasoning,
        },
      }),
    });
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createApprovalGate(
  vault: Vault,
  config?: Partial<ApprovalConfig>,
): ApprovalGate {
  return new ApprovalGate(vault, config);
}
