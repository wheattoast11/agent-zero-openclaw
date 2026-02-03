import { z } from 'zod';
import type { Vault } from '../security/vault.js';
import { createMoltbookBurnerAdapter } from './moltbookBurnerAdapter.js';
import { BurnerScheduler } from './burnerScheduler.js';

// ============================================================================
// SCHEMAS
// ============================================================================

export const Channel = z.enum(['whatsapp', 'telegram', 'discord', 'signal', 'moltbook']);
export type Channel = z.infer<typeof Channel>;

export const BurnerIdentity = z.object({
  id: z.string().uuid(),
  channel: Channel,
  handle: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  active: z.boolean(),
  metadata: z.record(z.unknown()),
});
export type BurnerIdentity = z.infer<typeof BurnerIdentity>;

export const BurnerConfig = z.object({
  defaultTTL: z.number(),
  maxIdentities: z.number(),
  proxyEnabled: z.boolean(),
  rateLimits: z.record(
    Channel,
    z.object({
      create: z.number(),
      destroy: z.number(),
    })
  ),
});
export type BurnerConfig = z.infer<typeof BurnerConfig>;

// ============================================================================
// PROVISIONING ADAPTER INTERFACE
// ============================================================================

export interface ProvisioningResult {
  handle: string;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ProvisioningAdapter {
  provision(): Promise<ProvisioningResult>;
  deprovision(credentials: Record<string, unknown>): Promise<void>;
}

// ============================================================================
// DEFAULT ADAPTERS (PLACEHOLDER IMPLEMENTATIONS)
// ============================================================================

class WhatsAppAdapter implements ProvisioningAdapter {
  async provision(): Promise<ProvisioningResult> {
    throw new Error('whatsapp burner provisioning not implemented. Only Moltbook provisioner is available.');
  }

  async deprovision(credentials: Record<string, unknown>): Promise<void> {
    throw new Error('whatsapp burner provisioning not implemented. Only Moltbook provisioner is available.');
  }
}

class TelegramAdapter implements ProvisioningAdapter {
  async provision(): Promise<ProvisioningResult> {
    throw new Error('telegram burner provisioning not implemented. Only Moltbook provisioner is available.');
  }

  async deprovision(credentials: Record<string, unknown>): Promise<void> {
    throw new Error('telegram burner provisioning not implemented. Only Moltbook provisioner is available.');
  }
}

class DiscordAdapter implements ProvisioningAdapter {
  async provision(): Promise<ProvisioningResult> {
    throw new Error('discord burner provisioning not implemented. Only Moltbook provisioner is available.');
  }

  async deprovision(credentials: Record<string, unknown>): Promise<void> {
    throw new Error('discord burner provisioning not implemented. Only Moltbook provisioner is available.');
  }
}

class SignalAdapter implements ProvisioningAdapter {
  async provision(): Promise<ProvisioningResult> {
    throw new Error('signal burner provisioning not implemented. Only Moltbook provisioner is available.');
  }

  async deprovision(credentials: Record<string, unknown>): Promise<void> {
    throw new Error('signal burner provisioning not implemented. Only Moltbook provisioner is available.');
  }
}

// ============================================================================
// BURNER MANAGER
// ============================================================================

const DEFAULT_CONFIG: BurnerConfig = {
  defaultTTL: 3600000, // 1 hour
  maxIdentities: 100,
  proxyEnabled: false,
  rateLimits: {
    whatsapp: { create: 5, destroy: 10 },
    telegram: { create: 10, destroy: 20 },
    discord: { create: 10, destroy: 20 },
    signal: { create: 5, destroy: 10 },
    moltbook: { create: 20, destroy: 40 },
  },
};

export class BurnerManager {
  private vault: Vault;
  private config: BurnerConfig;
  private adapters: Map<Channel, ProvisioningAdapter>;
  private creationTimestamps: Map<Channel, number[]> = new Map();
  private scheduler: BurnerScheduler;
  private initialized = false;

  constructor(vault: Vault, config?: Partial<BurnerConfig>) {
    this.vault = vault;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.adapters = new Map([
      ['whatsapp', new WhatsAppAdapter()],
      ['telegram', new TelegramAdapter()],
      ['discord', new DiscordAdapter()],
      ['signal', new SignalAdapter()],
    ]);

    this.scheduler = new BurnerScheduler(vault, async (id) => { await this.rotate(id); });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.scheduler.loadFromVault();
    this.initialized = true;
  }

  async create(channel: Channel, ttl?: number): Promise<BurnerIdentity> {
    await this.enforceRateLimit(channel, 'create');

    const identities = await this.getRegistry();
    if (identities.length >= this.config.maxIdentities) {
      throw new Error(`Maximum identities (${this.config.maxIdentities}) reached`);
    }

    let adapter = this.adapters.get(channel);

    // Use real Moltbook adapter if channel is moltbook
    if (channel === 'moltbook') {
      const moltbookAdapter = createMoltbookBurnerAdapter(this.vault);
      const username = `agent_${crypto.randomUUID().slice(0, 8)}`;
      const creds = await moltbookAdapter.provision(username);

      const identity: BurnerIdentity = {
        id: crypto.randomUUID(),
        channel,
        handle: creds.username,
        createdAt: Date.now(),
        expiresAt: Date.now() + (ttl ?? this.config.defaultTTL),
        active: true,
        metadata: { agentId: creds.agentId, registeredAt: creds.registeredAt },
      };

      await this.saveToRegistry(identity);
      return identity;
    }

    if (!adapter) throw new Error(`No adapter for channel: ${channel}`);

    const { handle, credentials, metadata } = await adapter.provision();

    const identity: BurnerIdentity = {
      id: crypto.randomUUID(),
      channel,
      handle,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttl ?? this.config.defaultTTL),
      active: true,
      metadata,
    };

    await this.vault.store(`burner:${identity.id}`, JSON.stringify(credentials));
    await this.saveToRegistry(identity);

    return identity;
  }

  async destroy(id: string): Promise<void> {
    const identity = await this.getIdentityById(id);
    if (!identity) throw new Error(`Identity not found: ${id}`);

    await this.enforceRateLimit(identity.channel, 'destroy');

    const credStr = await this.vault.retrieve(`burner:${identity.id}`);
    if (credStr) {
      const credentials = JSON.parse(credStr) as Record<string, unknown>;
      const adapter = this.adapters.get(identity.channel);
      await adapter?.deprovision(credentials);
    }

    await this.vault.delete(`burner:${identity.id}`);
    await this.removeFromRegistry(id);
  }

  async rotate(id: string): Promise<BurnerIdentity> {
    const oldIdentity = await this.getIdentityById(id);
    if (!oldIdentity) throw new Error(`Identity not found: ${id}`);

    const ttl = oldIdentity.expiresAt - oldIdentity.createdAt;
    const newIdentity = await this.create(oldIdentity.channel, ttl);

    await this.destroy(id);

    return newIdentity;
  }

  async list(channel?: Channel): Promise<BurnerIdentity[]> {
    const identities = await this.getRegistry();
    return channel ? identities.filter((i) => i.channel === channel) : identities;
  }

  async cleanup(): Promise<number> {
    const identities = await this.getRegistry();
    const now = Date.now();
    const expired = identities.filter((i) => i.expiresAt <= now);

    for (const identity of expired) {
      try {
        await this.destroy(identity.id);
      } catch {
        // Mark inactive if deprovision fails
        identity.active = false;
        identity.metadata.cleanupFailed = true;
      }
    }

    return expired.length;
  }

  async getStats(): Promise<{ active: Record<Channel, number>; expired: number; total: number }> {
    return this.getRegistry().then((identities) => {
      const now = Date.now();
      const active: Record<Channel, number> = {
        whatsapp: 0,
        telegram: 0,
        discord: 0,
        signal: 0,
        moltbook: 0,
      };

      let expired = 0;

      for (const identity of identities) {
        if (identity.expiresAt <= now) {
          expired++;
        } else if (identity.active) {
          active[identity.channel]++;
        }
      }

      return { active, expired, total: identities.length };
    });
  }

  async scheduleRotation(id: string, intervalMs: number): Promise<void> {
    const identity = await this.getIdentityById(id);
    if (!identity) throw new Error(`Identity not found: ${id}`);
    await this.scheduler.schedule(id, intervalMs);
  }

  async stopRotation(id: string): Promise<void> {
    await this.scheduler.stop(id);
  }

  async stopAllRotations(): Promise<void> {
    await this.scheduler.stopAll();
  }

  private async getRegistry(): Promise<BurnerIdentity[]> {
    const raw = await this.vault.retrieve('burner:registry');
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return z.array(BurnerIdentity).parse(data);
  }

  private async saveToRegistry(identity: BurnerIdentity): Promise<void> {
    const identities = await this.getRegistry();
    identities.push(identity);
    await this.vault.store('burner:registry', JSON.stringify(identities));
  }

  private async removeFromRegistry(id: string): Promise<void> {
    const identities = await this.getRegistry();
    const filtered = identities.filter((i) => i.id !== id);
    await this.vault.store('burner:registry', JSON.stringify(filtered));
  }

  private async getIdentityById(id: string): Promise<BurnerIdentity | null> {
    const identities = await this.getRegistry();
    return identities.find((i) => i.id === id) ?? null;
  }

  private async enforceRateLimit(channel: Channel, action: 'create' | 'destroy'): Promise<void> {
    const channelLimits = this.config.rateLimits[channel];
    if (!channelLimits) return;
    const limit = channelLimits[action];
    const timestamps = this.creationTimestamps.get(channel) ?? [];
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window

    const recentOps = timestamps.filter((t) => t > windowStart);

    if (recentOps.length >= limit) {
      throw new Error(`Rate limit exceeded for ${channel} ${action}: ${limit}/min`);
    }

    recentOps.push(now);
    this.creationTimestamps.set(channel, recentOps);
  }
}
