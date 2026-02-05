#!/usr/bin/env npx tsx
/**
 * Moltbook Queue Manager
 *
 * Manage the approval gate queue: list, bulk approve, clear stale, toggle mode.
 * Loads .env automatically — just run: npx tsx scripts/moltbook-queue-manage.ts <command>
 *
 * Commands:
 *   list                         List all pending items
 *   approve --threshold=0.7      Bulk approve items above confidence threshold
 *   clear --max-age=48           Clear items older than N hours
 *   toggle                       Toggle daemon mode (supervised <-> autonomous)
 *   mode                         Show current daemon mode
 */

import 'dotenv/config';
import { Vault } from '../src/security/vault.js';
import { ApprovalGate, type QueuedResponse } from '../src/moltbook/approvalGate.js';

const MODE_VAULT_KEY = 'moltbook:daemon:mode';
const API_BASE = 'https://www.moltbook.com/api/v1';

async function main() {
  const passphrase = process.env.VAULT_PASSPHRASE;
  if (!passphrase) {
    console.error('VAULT_PASSPHRASE env var required');
    process.exit(1);
  }

  const vault = await Vault.create(passphrase);
  const gate = new ApprovalGate(vault);

  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'list':
      await cmdList(gate);
      break;
    case 'approve':
      await cmdApprove(gate, vault, rest);
      break;
    case 'clear':
      await cmdClear(gate, rest);
      break;
    case 'toggle':
      await cmdToggle(vault);
      break;
    case 'mode':
      await cmdMode(vault);
      break;
    default:
      console.log(`Usage: npx tsx scripts/moltbook-queue-manage.ts <command>

Commands:
  list                         List all pending items with confidence scores
  approve --threshold=0.7      Bulk approve items above confidence threshold
  clear --max-age=48           Clear items older than N hours
  toggle                       Toggle daemon mode (supervised <-> autonomous)
  mode                         Show current daemon mode`);
      break;
  }
}

async function cmdList(gate: ApprovalGate): Promise<void> {
  const pending = await gate.listPending();

  if (pending.length === 0) {
    console.log('No pending items in queue.');
    return;
  }

  console.log(`\n${pending.length} pending items:\n`);
  console.log('ID                                    | Conf  | Action  | Age        | Preview');
  console.log('--------------------------------------+-------+---------+------------+--------');

  for (const item of pending) {
    const age = getAge(item.queuedAt);
    const conf = (item.response.confidence * 100).toFixed(0).padStart(3) + '%';
    const action = item.response.action.padEnd(7);
    const preview = (item.response.content ?? '').slice(0, 50).replace(/\n/g, ' ');
    console.log(`${item.id} | ${conf}  | ${action} | ${age.padEnd(10)} | ${preview}`);
  }

  // Summary stats
  const confs = pending.map(p => p.response.confidence);
  const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
  const above70 = confs.filter(c => c >= 0.7).length;
  const above80 = confs.filter(c => c >= 0.8).length;

  console.log(`\nSummary: ${pending.length} pending | avg confidence: ${(avg * 100).toFixed(0)}% | >=70%: ${above70} | >=80%: ${above80}`);
}

async function cmdApprove(gate: ApprovalGate, vault: Vault, args: string[]): Promise<void> {
  const thresholdArg = args.find(a => a.startsWith('--threshold='));
  const threshold = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : 0.7;

  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    console.error('Invalid threshold. Must be between 0 and 1.');
    process.exit(1);
  }

  const pending = await gate.listPending();
  const eligible = pending.filter(p => p.response.confidence >= threshold);

  if (eligible.length === 0) {
    console.log(`No items above ${(threshold * 100).toFixed(0)}% confidence threshold.`);
    return;
  }

  console.log(`\nApproving ${eligible.length}/${pending.length} items above ${(threshold * 100).toFixed(0)}% confidence...\n`);

  // Load moltbook token for posting
  const moltbookToken = await vault.retrieve('moltbook:api_token');

  let approved = 0;
  let posted = 0;
  let errors = 0;

  for (const item of eligible) {
    try {
      const response = await gate.approve(item.id);
      if (!response) {
        errors++;
        continue;
      }
      approved++;

      // If we have a token, actually post the approved item
      if (moltbookToken && response.action !== 'skip') {
        try {
          await postToMoltbook(moltbookToken, response);
          posted++;
          console.log(`  [${item.id.slice(0, 8)}] approved + posted (${response.action}, ${(item.response.confidence * 100).toFixed(0)}%)`);
        } catch (err) {
          console.log(`  [${item.id.slice(0, 8)}] approved but post failed: ${(err as Error).message}`);
        }
      } else {
        console.log(`  [${item.id.slice(0, 8)}] approved (${response.action}, ${(item.response.confidence * 100).toFixed(0)}%)`);
      }
    } catch (err) {
      errors++;
      console.log(`  [${item.id.slice(0, 8)}] error: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone: ${approved} approved, ${posted} posted, ${errors} errors`);

  // Clean up approved items
  const cleaned = await gate.cleanup();
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} processed items from queue.`);
  }
}

async function cmdClear(gate: ApprovalGate, args: string[]): Promise<void> {
  const maxAgeArg = args.find(a => a.startsWith('--max-age='));
  const maxAgeHours = maxAgeArg ? parseFloat(maxAgeArg.split('=')[1]) : 48;

  if (isNaN(maxAgeHours) || maxAgeHours <= 0) {
    console.error('Invalid max-age. Must be a positive number of hours.');
    process.exit(1);
  }

  const pending = await gate.listPending();
  const cutoff = Date.now() - maxAgeHours * 3600000;
  const stale = pending.filter(p => new Date(p.queuedAt).getTime() < cutoff);

  if (stale.length === 0) {
    console.log(`No items older than ${maxAgeHours}h.`);
    return;
  }

  console.log(`\nClearing ${stale.length} items older than ${maxAgeHours}h...\n`);

  let cleared = 0;
  for (const item of stale) {
    const ok = await gate.reject(item.id);
    if (ok) {
      cleared++;
      console.log(`  [${item.id.slice(0, 8)}] cleared (${getAge(item.queuedAt)} old, ${(item.response.confidence * 100).toFixed(0)}%)`);
    }
  }

  console.log(`\nCleared ${cleared}/${stale.length} stale items.`);
}

async function cmdToggle(vault: Vault): Promise<void> {
  const current = await vault.retrieve(MODE_VAULT_KEY);
  const next = current === 'autonomous' ? 'supervised' : 'autonomous';
  await vault.store(MODE_VAULT_KEY, next);
  console.log(`Daemon mode: ${current ?? 'supervised'} -> ${next}`);
  console.log('Note: Running daemon will pick up the change on next cycle.');
}

async function cmdMode(vault: Vault): Promise<void> {
  const mode = await vault.retrieve(MODE_VAULT_KEY) ?? 'supervised';
  console.log(`Current daemon mode: ${mode}`);
}

// ============================================================================
// HELPERS
// ============================================================================

function getAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function postToMoltbook(
  token: string,
  response: { action: string; content: string; threadId: string },
): Promise<void> {
  if (response.action === 'comment') {
    const res = await fetch(`${API_BASE}/posts/${response.threadId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'AgentZero/0.2.0',
      },
      body: JSON.stringify({ content: response.content }),
    });
    if (!res.ok) throw new Error(`Comment failed (${res.status})`);
  } else if (response.action === 'upvote') {
    const res = await fetch(`${API_BASE}/posts/${response.threadId}/upvote`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'AgentZero/0.2.0',
      },
    });
    if (!res.ok) throw new Error(`Upvote failed (${res.status})`);
  } else if (response.action === 'post') {
    const content = response.content ?? '';
    const parts = content.split('\n---\n');
    const title = parts[0] ?? 'Untitled';
    const body = parts.slice(1).join('\n---\n') || content;
    const res = await fetch(`${API_BASE}/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'AgentZero/0.2.0',
      },
      body: JSON.stringify({ title, content: body, submolt: 'general' }),
    });
    if (!res.ok) throw new Error(`Post failed (${res.status})`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
