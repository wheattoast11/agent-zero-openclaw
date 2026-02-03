/**
 * Moltbook CLI Commands
 *
 * agent-zero moltbook daemon [--supervised|--autonomous]
 * agent-zero moltbook review
 * agent-zero moltbook status
 * agent-zero moltbook toggle
 * agent-zero moltbook post <title> [--submolt=general]
 */

import chalk from 'chalk';
import { createVault } from '../security/vault.js';
import { MoltbookDaemon, createMoltbookDaemon } from '../moltbook/daemon.js';
import { createApprovalGate, type ApprovalMode } from '../moltbook/approvalGate.js';
import { createMoltbookAdapter } from '../channels/moltbook.js';
import { createResponseComposer } from '../moltbook/responseComposer.js';
import { createInterface } from 'readline';

// ============================================================================
// MAIN DISPATCHER
// ============================================================================

export async function moltbookCli(args: string[]): Promise<void> {
  const subcommand = args[0] || 'help';

  switch (subcommand) {
    case 'daemon':
      await daemonCommand(args.slice(1));
      break;
    case 'review':
      await reviewCommand();
      break;
    case 'status':
      await statusCommand();
      break;
    case 'toggle':
      await toggleCommand();
      break;
    case 'post':
      await postCommand(args.slice(1));
      break;
    case 'help':
    default:
      showMoltbookHelp();
      break;
  }
}

// ============================================================================
// COMMANDS
// ============================================================================

async function daemonCommand(args: string[]): Promise<void> {
  const passphrase = requireEnv('VAULT_PASSPHRASE');
  const apiKey = requireEnv('OPENROUTER_API_KEY');
  const moltbookToken = requireEnv('MOLTBOOK_API_TOKEN');

  let mode: ApprovalMode = 'supervised';
  if (args.includes('--autonomous')) mode = 'autonomous';
  if (args.includes('--supervised')) mode = 'supervised';

  const vault = await createVault(passphrase);
  const identityId = (await vault.retrieve('moltbook:identity:id')) ?? 'zero-terminals';

  const daemon = createMoltbookDaemon({
    vault,
    apiKey,
    moltbookToken,
    identityId,
    mode,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '1800000'),
    maxEngagementsPerCycle: parseInt(process.env.MAX_ENGAGEMENTS ?? '3'),
    model: process.env.OPENROUTER_MODEL,
    webhookUrl: process.env.WEBHOOK_URL,
    autoApproveThreshold: parseFloat(process.env.AUTO_APPROVE_THRESHOLD ?? '0.8'),
  });

  daemon.on('cycle:end', (stats) => {
    console.log(chalk.gray(
      `[${new Date().toISOString()}] ` +
      `polled=${stats.polled} scored=${stats.scored} composed=${stats.composed} ` +
      `posted=${stats.posted} queued=${stats.queued} skipped=${stats.skipped} ` +
      `bait=${stats.bait} errors=${stats.errors}`
    ));
  });

  daemon.on('engagement', (threadId, action) => {
    console.log(chalk.green(`  → ${action} on ${threadId}`));
  });

  daemon.on('error', (err) => {
    console.error(chalk.red(`  ✗ ${err.message}`));
  });

  daemon.on('mode:change', (newMode) => {
    console.log(chalk.yellow(`  Mode changed to: ${newMode}`));
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\nShutting down daemon...'));
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });

  await daemon.start();

  // Keep alive
  console.log(chalk.gray('Press Ctrl+C to stop'));
  await new Promise(() => {}); // block forever
}

async function reviewCommand(): Promise<void> {
  const passphrase = requireEnv('VAULT_PASSPHRASE');
  const vault = await createVault(passphrase);
  const gate = createApprovalGate(vault);

  const pending = await gate.listPending();

  if (pending.length === 0) {
    console.log(chalk.gray('No pending responses in queue.'));
    return;
  }

  console.log(chalk.cyan(`\n${pending.length} pending response(s):\n`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  for (const item of pending) {
    const r = item.response;
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.gray(`ID: ${item.id}`));
    console.log(chalk.gray(`Queued: ${item.queuedAt}`));
    console.log(chalk.gray(`Thread: ${r.threadId}`));
    console.log(chalk.gray(`Action: ${r.action} | Confidence: ${(r.confidence * 100).toFixed(0)}%`));
    console.log(chalk.gray(`Reasoning: ${r.reasoning}`));
    console.log(chalk.white(`\nContent:\n${r.content}\n`));

    const answer = await ask(chalk.yellow('[a]pprove / [r]eject / [s]kip? '));

    if (answer.startsWith('a')) {
      const approved = await gate.approve(item.id);
      if (approved) {
        // Execute the approved action
        try {
          const moltbookToken = requireEnv('MOLTBOOK_API_TOKEN');
          const adapter = createMoltbookAdapter({
            identityId: 'zero-terminals',
            apiToken: moltbookToken,
            vault,
          });
          await adapter.connect();

          if (approved.action === 'comment') {
            await adapter.createComment(approved.threadId, approved.content);
            console.log(chalk.green('  ✓ Comment posted'));
          } else if (approved.action === 'upvote') {
            await adapter.upvote(approved.threadId);
            console.log(chalk.green('  ✓ Upvoted'));
          } else if (approved.action === 'post') {
            const parts = approved.content.split('\n---\n');
            await adapter.createPost(parts[0] ?? 'Untitled', parts.slice(1).join('\n---\n') || approved.content);
            console.log(chalk.green('  ✓ Post created'));
          }

          await adapter.disconnect();
        } catch (err) {
          console.error(chalk.red(`  ✗ Failed to post: ${(err as Error).message}`));
        }
      }
    } else if (answer.startsWith('r')) {
      await gate.reject(item.id);
      console.log(chalk.red('  ✗ Rejected'));
    } else {
      console.log(chalk.gray('  ○ Skipped'));
    }
  }

  rl.close();
}

async function statusCommand(): Promise<void> {
  const passphrase = requireEnv('VAULT_PASSPHRASE');
  const vault = await createVault(passphrase);
  const gate = createApprovalGate(vault);

  await gate.loadMode();
  const pending = await gate.listPending();

  console.log(chalk.cyan('\nMoltbook Daemon Status\n'));
  console.log(chalk.gray('  Mode:          ') + chalk.white(gate.getMode()));
  console.log(chalk.gray('  Queue depth:   ') + chalk.white(String(pending.length)));
  console.log(chalk.gray('  Log file:      ') + chalk.blue('~/.agent-zero/logs/moltbook-daemon.jsonl'));
  console.log(chalk.gray('  Queue dir:     ') + chalk.blue('~/.agent-zero/moltbook-queue/'));
  console.log();
}

async function toggleCommand(): Promise<void> {
  const passphrase = requireEnv('VAULT_PASSPHRASE');
  const vault = await createVault(passphrase);
  const gate = createApprovalGate(vault);

  await gate.loadMode();
  const oldMode = gate.getMode();
  const newMode = await gate.toggleMode();

  console.log(chalk.yellow(`Mode: ${oldMode} → ${newMode}`));
}

async function postCommand(args: string[]): Promise<void> {
  const passphrase = requireEnv('VAULT_PASSPHRASE');
  const apiKey = requireEnv('OPENROUTER_API_KEY');
  const moltbookToken = requireEnv('MOLTBOOK_API_TOKEN');

  const title = args[0];
  if (!title) {
    console.error(chalk.red('Usage: agent-zero moltbook post <title> [--submolt=general]'));
    process.exit(1);
  }

  const submoltArg = args.find(a => a.startsWith('--submolt='));
  const submolt = submoltArg?.split('=')[1] ?? 'general';

  const vault = await createVault(passphrase);
  const composer = createResponseComposer({ apiKey });
  const composed = await composer.composeOriginalPost(title, submolt);

  if (composed.action === 'skip' || !composed.content) {
    console.log(chalk.yellow(`Composer skipped: ${composed.reasoning}`));
    return;
  }

  const parts = composed.content.split('\n---\n');
  const postTitle = parts[0] ?? title;
  const body = parts.slice(1).join('\n---\n') || composed.content;

  console.log(chalk.cyan('\nComposed post:'));
  console.log(chalk.white(`Title: ${postTitle}`));
  console.log(chalk.gray(body));
  console.log(chalk.gray(`\nConfidence: ${(composed.confidence * 100).toFixed(0)}%`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(chalk.yellow('\nPost? [y/n] '), resolve));
  rl.close();

  if (!answer.startsWith('y')) {
    console.log(chalk.gray('Cancelled'));
    return;
  }

  const adapter = createMoltbookAdapter({
    identityId: 'zero-terminals',
    apiToken: moltbookToken,
    vault,
  });
  await adapter.connect();
  const post = await adapter.createPost(postTitle, body, submolt);
  await adapter.disconnect();

  console.log(chalk.green(`✓ Posted: ${post.id}`));
}

// ============================================================================
// HELPERS
// ============================================================================

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(chalk.red(`Missing required environment variable: ${name}`));
    process.exit(1);
  }
  return val;
}

function showMoltbookHelp(): void {
  console.log(chalk.cyan('Usage: agent-zero moltbook <command>\n'));
  console.log(chalk.white('Commands:'));
  console.log(chalk.gray('  daemon [--supervised|--autonomous]') + '  Start engagement daemon');
  console.log(chalk.gray('  review') + '                              Review pending queue');
  console.log(chalk.gray('  status') + '                              Show daemon status');
  console.log(chalk.gray('  toggle') + '                              Switch supervised↔autonomous');
  console.log(chalk.gray('  post <title> [--submolt=general]') + '    Compose and post');
  console.log(chalk.gray('  help') + '                                Show this help');
  console.log();
  console.log(chalk.white('Environment:'));
  console.log(chalk.gray('  VAULT_PASSPHRASE') + '     Required for all commands');
  console.log(chalk.gray('  OPENROUTER_API_KEY') + '   Required for daemon/post');
  console.log(chalk.gray('  MOLTBOOK_API_TOKEN') + '   Required for daemon/review/post');
  console.log(chalk.gray('  POLL_INTERVAL_MS') + '     Poll interval (default: 1800000)');
  console.log(chalk.gray('  MAX_ENGAGEMENTS') + '      Per cycle (default: 3)');
  console.log(chalk.gray('  OPENROUTER_MODEL') + '     LLM model override');
  console.log(chalk.gray('  WEBHOOK_URL') + '          Review notification webhook');
  console.log();
}
