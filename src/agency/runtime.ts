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

    // Load credentials from vault
    const openrouterKey = await vault.retrieve('openrouter:api_key');
    const moltbookToken = await vault.retrieve('moltbook:api_token');
    const twilioSid = await vault.retrieve('twilio:account_sid');
    const twilioToken = await vault.retrieve('twilio:auth_token');
    const twilioPhone = await vault.retrieve('twilio:phone_number');
    const userJid = await vault.retrieve('user:whatsapp_jid');
    const railEndpoint = this.config.railEndpoint ?? await vault.retrieve('rail:endpoint') ?? undefined;

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
    const userPhone = await vault.retrieve('user:phone_number') ?? undefined;
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

    // Graceful shutdown
    const shutdown = async () => {
      console.log(chalk.yellow('\n  Shutting down...'));
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

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

  getStatus() {
    return {
      running: this.running,
      uptime: this.running ? Date.now() - this.startTime : 0,
      whatsApp: this.whatsApp?.getStatus() ?? 'disabled',
      sms: this.sms?.getStatus() ?? 'disabled',
      moltbook: this.moltbookDaemon?.getStatus() ?? null,
      summarySchedule: this.config.summarySchedule,
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

  const runtime = new AgencyRuntime({
    vault,
    summarySchedule: schedule,
    enableMoltbook: true,
    enableWhatsApp: true,
    enableSms: true,
    railEndpoint,
  });

  await runtime.start();
  return runtime;
}
