/**
 * Unified Agency Runtime
 *
 * Single entry point for the 24/7 Agent Zero agency.
 * Manages WhatsApp bridge, Moltbook daemon, summary scheduler, and command router.
 */

import chalk from 'chalk';
import { Vault, createVault } from '../security/vault.js';
import { WhatsAppAdapter, createWhatsAppAdapter } from '../channels/whatsapp.js';
import { SmsAdapter, createSmsAdapter } from '../channels/sms.js';
import { MoltbookDaemon, createMoltbookDaemon } from '../moltbook/daemon.js';
import { createDaemonObserver, DaemonObserver } from '../moltbook/observer.js';
import { SummaryScheduler, createSummaryScheduler, type SummarySchedule } from './summaryScheduler.js';
import { CommandRouter, createCommandRouter } from './commandRouter.js';
import { OperationalVault } from '../identity/operationalVault.js';
import type { SummarySources } from './summaryGenerator.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AgencyConfig {
  vault: Vault;
  summarySchedule: SummarySchedule;
  enableMoltbook: boolean;
  enableWhatsApp: boolean;
  enableSms: boolean;
  railEndpoint?: string;
  activePostIds?: string[];
}

// ============================================================================
// RUNTIME
// ============================================================================

export class AgencyRuntime {
  private config: AgencyConfig;
  private whatsApp?: WhatsAppAdapter;
  private sms?: SmsAdapter;
  private moltbookDaemon?: MoltbookDaemon;
  private summaryScheduler?: SummaryScheduler;
  private commandRouter?: CommandRouter;
  private observer: DaemonObserver;
  private operationalVault?: OperationalVault;
  private startTime = 0;
  private running = false;
  private shuttingDown = false;
  private signalHandlers: { signal: string; handler: () => void }[] = [];
  private pauseState: Map<string, boolean> = new Map();

  constructor(config: AgencyConfig) {
    this.config = config;
    this.observer = createDaemonObserver();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.startTime = Date.now();
    this.running = true;

    const vault = this.config.vault;

    console.log(chalk.cyan('  Starting Agent Zero Agency Runtime\n'));

    // Start observer
    await this.observer.start();

    // Load credentials from vault, with env var fallback (vault fingerprint drift workaround)
    const openrouterKey = await vault.retrieve('openrouter:api_key') ?? process.env['OPENROUTER_API_KEY'] ?? null;
    const moltbookToken = await vault.retrieve('moltbook:api_token') ?? process.env['MOLTBOOK_API_TOKEN'] ?? null;
    const twilioSid = await vault.retrieve('twilio:account_sid') ?? process.env['TWILIO_ACCOUNT_SID'] ?? null;
    const twilioToken = await vault.retrieve('twilio:auth_token') ?? process.env['TWILIO_AUTH_TOKEN'] ?? null;
    const twilioPhone = await vault.retrieve('twilio:phone_number') ?? process.env['TWILIO_PHONE_NUMBER'] ?? null;
    const userJid = await vault.retrieve('user:whatsapp_jid') ?? process.env['WHATSAPP_USER_JID'] ?? null;
    const railEndpoint = this.config.railEndpoint ?? await vault.retrieve('rail:endpoint') ?? process.env['RAIL_ENDPOINT'] ?? undefined;

    // Start operational vault for metrics (reuse agency vault for passphrase consistency)
    try {
      this.operationalVault = await OperationalVault.fromVault(vault);
      if (railEndpoint) {
        await this.operationalVault.initSelfIdentity(railEndpoint);
      }
      console.log(chalk.green('  ✓ Operational vault'));
    } catch (err) {
      console.log(chalk.yellow('  ○ Operational vault unavailable'));
    }

    // Start WhatsApp
    if (this.config.enableWhatsApp && twilioSid && twilioToken && userJid) {
      try {
        this.whatsApp = createWhatsAppAdapter({
          identityId: 'agency-primary',
          twilioAccountSid: twilioSid,
          twilioAuthToken: twilioToken,
          phoneNumber: twilioPhone ?? undefined,
        }, vault);

        // Listen for connection events to display clean status
        this.whatsApp.on('auth:failed', () => {
          console.log(chalk.red('  ✗ WhatsApp: authentication failed after max retries'));
        });

        await this.whatsApp.connect();
        console.log(chalk.green('  ✓ WhatsApp connected'));
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === 'Connection timeout') {
          // Timeout likely means QR was shown but not scanned — adapter stays alive for retry
          console.log(chalk.yellow('  ○ WhatsApp: waiting for QR scan (will retry in background)'));
        } else {
          console.log(chalk.red(`  ✗ WhatsApp: ${msg}`));
          this.whatsApp = undefined;
        }
      }
    } else if (this.config.enableWhatsApp) {
      console.log(chalk.yellow('  ○ WhatsApp: missing credentials (run `agent-zero setup`)'));
    }

    // Start SMS adapter
    if (this.config.enableSms && twilioSid && twilioToken && twilioPhone) {
      try {
        const userPhone = await vault.retrieve('user:phone_number') ?? undefined;
        this.sms = createSmsAdapter({
          twilioAccountSid: twilioSid,
          twilioAuthToken: twilioToken,
          phoneNumber: twilioPhone,
          webhookUrl: process.env['SMS_WEBHOOK_URL'] ?? 'https://agent-zero-agency.fly.dev/sms/inbound',
        });
        await this.sms.connect();
        console.log(chalk.green(`  ✓ SMS webhook (port ${process.env['SMS_WEBHOOK_PORT'] || 8080})`));
      } catch (err) {
        console.log(chalk.red(`  ✗ SMS: ${(err as Error).message}`));
        this.sms = undefined;
      }
    } else if (this.config.enableSms) {
      console.log(chalk.yellow('  ○ SMS: missing Twilio credentials'));
    }

    // Start Moltbook daemon
    if (this.config.enableMoltbook && openrouterKey && moltbookToken) {
      try {
        this.moltbookDaemon = createMoltbookDaemon({
          pollIntervalMs: 1_800_000,
          maxEngagementsPerCycle: 3,
          engagementIntervalMs: 7_200_000,
          activePostIds: this.config.activePostIds ?? [],
          enableOriginalPosts: true,
          apiKey: openrouterKey,
          moltbookToken,
          vault,
          identityId: 'agency-moltbook',
          railEndpoint,
        });
        await this.moltbookDaemon.start();
        console.log(chalk.green(`  ✓ Moltbook daemon (${this.moltbookDaemon.getMode()})`));
      } catch (err) {
        console.log(chalk.red(`  ✗ Moltbook: ${(err as Error).message}`));
        this.moltbookDaemon = undefined;
      }
    } else if (this.config.enableMoltbook) {
      console.log(chalk.yellow('  ○ Moltbook: missing credentials'));
    }

    // Start summary scheduler
    if (this.whatsApp && userJid) {
      const sources: SummarySources = {
        moltbookDaemon: this.moltbookDaemon,
        operationalVault: this.operationalVault,
        startTime: this.startTime,
      };

      this.summaryScheduler = createSummaryScheduler({
        schedule: this.config.summarySchedule,
        userJid,
        whatsApp: this.whatsApp,
        sources,
      });
      this.summaryScheduler.start();
      console.log(chalk.green(`  ✓ Summary scheduler (${this.config.summarySchedule})`));
    }

    // Start command router
    // Derive E.164 phone from WhatsApp JID (15551234567@s.whatsapp.net -> +15551234567)
    const userPhone = userJid ? '+' + userJid.split('@')[0] : undefined;
    if (this.whatsApp && userJid) {
      this.commandRouter = createCommandRouter({
        userJid,
        whatsApp: this.whatsApp,
        sms: this.sms,
        userPhone,
        moltbookDaemon: this.moltbookDaemon,
        summaryScheduler: this.summaryScheduler,
        llmApiKey: openrouterKey ?? undefined,
        startTime: this.startTime,
        observer: this.observer,
      });
      this.commandRouter.attach();
      console.log(chalk.green('  ✓ Command router'));
    }

    console.log(chalk.cyan('\n  Agency runtime active. Press Ctrl+C to stop.\n'));

    // Graceful shutdown with timeout and double-signal protection
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) {
        console.log(chalk.red('\n  Force exit (second signal).'));
        process.exit(1);
      }
      this.shuttingDown = true;
      console.log(chalk.yellow(`\n  Shutting down (${signal})...`));

      const timeout = setTimeout(() => {
        console.log(chalk.red('  Shutdown timed out after 10s — force exit.'));
        process.exit(1);
      }, 10_000);

      try {
        await this.stop();
      } finally {
        clearTimeout(timeout);
      }
      process.exit(0);
    };

    // Remove previous handlers to prevent duplicate registration on restart
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    const sigintHandler = () => void shutdown('SIGINT');
    const sigtermHandler = () => void shutdown('SIGTERM');
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
    this.signalHandlers.push(
      { signal: 'SIGINT', handler: sigintHandler },
      { signal: 'SIGTERM', handler: sigtermHandler },
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Clean up signal handlers
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    if (this.summaryScheduler) {
      this.summaryScheduler.stop();
    }

    if (this.moltbookDaemon) {
      await this.moltbookDaemon.stop();
    }

    if (this.sms) {
      await this.sms.disconnect();
    }

    if (this.whatsApp) {
      await this.whatsApp.disconnect();
    }

    if (this.operationalVault) {
      await this.operationalVault.close();
    }

    await this.observer.stop();

    console.log(chalk.green('  Agency runtime stopped.'));
  }

  // ==========================================================================
  // PAUSE / RESUME
  // ==========================================================================

  private readonly SUBSYSTEM_NAMES = ['moltbook', 'summary', 'whatsapp', 'sms'] as const;

  /**
   * Pause a subsystem (or 'all'). Returns current pause/active lists.
   */
  pause(subsystem: string): { paused: string[]; active: string[] } {
    const targets = subsystem === 'all' ? [...this.SUBSYSTEM_NAMES] : [subsystem];

    for (const target of targets) {
      if (!this.SUBSYSTEM_NAMES.includes(target as any) && target !== 'all') continue;
      this.pauseState.set(target, true);
      this.applyPause(target);
    }

    return this.getPauseStatus();
  }

  /**
   * Resume a subsystem (or 'all'). Returns current pause/active lists.
   */
  resume(subsystem: string): { paused: string[]; active: string[] } {
    const targets = subsystem === 'all' ? [...this.SUBSYSTEM_NAMES] : [subsystem];

    for (const target of targets) {
      if (!this.SUBSYSTEM_NAMES.includes(target as any) && target !== 'all') continue;
      this.pauseState.set(target, false);
      this.applyResume(target);
    }

    return this.getPauseStatus();
  }

  /**
   * Get the current pause state map.
   */
  getPauseState(): Map<string, boolean> {
    return new Map(this.pauseState);
  }

  private getPauseStatus(): { paused: string[]; active: string[] } {
    const paused: string[] = [];
    const active: string[] = [];
    for (const name of this.SUBSYSTEM_NAMES) {
      if (this.pauseState.get(name)) {
        paused.push(name);
      } else {
        active.push(name);
      }
    }
    return { paused, active };
  }

  private applyPause(subsystem: string): void {
    switch (subsystem) {
      case 'moltbook':
        if (this.moltbookDaemon) {
          void this.moltbookDaemon.stop();
        }
        break;
      case 'summary':
        if (this.summaryScheduler) {
          this.summaryScheduler.stop();
        }
        break;
      case 'whatsapp':
        if (this.whatsApp) {
          void this.whatsApp.disconnect();
        }
        break;
      case 'sms':
        if (this.sms) {
          void this.sms.disconnect();
        }
        break;
    }
  }

  private applyResume(subsystem: string): void {
    switch (subsystem) {
      case 'moltbook':
        if (this.moltbookDaemon) {
          void this.moltbookDaemon.start();
        }
        break;
      case 'summary':
        if (this.summaryScheduler) {
          this.summaryScheduler.start();
        }
        break;
      case 'whatsapp':
        if (this.whatsApp) {
          void this.whatsApp.connect();
        }
        break;
      case 'sms':
        if (this.sms) {
          void this.sms.connect();
        }
        break;
    }
  }

  getStatus() {
    const pauseInfo: Record<string, boolean> = {};
    for (const name of this.SUBSYSTEM_NAMES) {
      pauseInfo[name] = this.pauseState.get(name) ?? false;
    }
    return {
      running: this.running,
      uptime: this.running ? Date.now() - this.startTime : 0,
      whatsApp: this.whatsApp?.getStatus() ?? 'disabled',
      sms: this.sms?.getStatus() ?? 'disabled',
      moltbook: this.moltbookDaemon?.getStatus() ?? null,
      summarySchedule: this.config.summarySchedule,
      paused: pauseInfo,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export async function startAgency(passphrase: string): Promise<AgencyRuntime> {
  const vault = await createVault(passphrase);

  const scheduleRaw = await vault.retrieve('agency:summary_schedule');
  const schedule: SummarySchedule = (['daily', 'twice-daily', 'on-demand'].includes(scheduleRaw ?? '') ? scheduleRaw : 'daily') as SummarySchedule;
  const railEndpoint = await vault.retrieve('rail:endpoint') ?? undefined;

  // Load active post IDs for engagement scanning (vault with env var fallback)
  let activePostIds: string[] = [];
  const activePostIdsRaw = await vault.retrieve('moltbook:active_posts') ?? process.env['MOLTBOOK_ACTIVE_POSTS'] ?? null;
  if (activePostIdsRaw) {
    try { activePostIds = JSON.parse(activePostIdsRaw) as string[]; } catch { /* ignore */ }
  }
  console.log(chalk.gray(`  Active post IDs: ${activePostIds.length} loaded${activePostIds.length ? '' : ' (vault key missing?)'}`));

  const runtime = new AgencyRuntime({
    vault,
    summarySchedule: schedule,
    enableMoltbook: true,
    enableWhatsApp: true,
    enableSms: true,
    railEndpoint,
    activePostIds,
  });

  await runtime.start();
  return runtime;
}
