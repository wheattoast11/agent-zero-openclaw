import { EventEmitter } from 'eventemitter3';
import type { Vault } from '../security/vault.js';

interface ScheduleEntry {
  identityId: string;
  intervalMs: number;
  nextRotation: number;
  failureCount: number;
}

export class BurnerScheduler extends EventEmitter {
  private schedules = new Map<string, ScheduleEntry>();
  private timers = new Map<string, NodeJS.Timeout>();
  private vault: Vault;
  private vaultKey = 'burner:schedules';
  private rotateFn: (id: string) => Promise<void>;

  constructor(vault: Vault, rotateFn: (id: string) => Promise<void>) {
    super();
    this.vault = vault;
    this.rotateFn = rotateFn;
  }

  async loadFromVault(): Promise<void> {
    const stored = await this.vault.retrieve(this.vaultKey);
    if (!stored) return;
    const entries: ScheduleEntry[] = JSON.parse(stored);
    for (const entry of entries) {
      this.schedules.set(entry.identityId, entry);
      this.startTimer(entry);
    }
  }

  async schedule(identityId: string, intervalMs: number): Promise<void> {
    const entry: ScheduleEntry = {
      identityId,
      intervalMs,
      nextRotation: Date.now() + intervalMs,
      failureCount: 0,
    };
    this.schedules.set(identityId, entry);
    this.startTimer(entry);
    await this.persist();
    this.emit('rotation:scheduled', { identityId, intervalMs });
  }

  async stop(identityId: string): Promise<void> {
    const timer = this.timers.get(identityId);
    if (timer) clearTimeout(timer);
    this.timers.delete(identityId);
    this.schedules.delete(identityId);
    await this.persist();
  }

  async stopAll(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.schedules.clear();
    await this.persist();
  }

  private startTimer(entry: ScheduleEntry): void {
    const existing = this.timers.get(entry.identityId);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, entry.nextRotation - Date.now());
    const timer = setTimeout(() => this.executeRotation(entry.identityId), delay);
    this.timers.set(entry.identityId, timer);
  }

  private async executeRotation(identityId: string): Promise<void> {
    const entry = this.schedules.get(identityId);
    if (!entry) return;

    try {
      await this.rotateFn(identityId);
      entry.failureCount = 0;
      entry.nextRotation = Date.now() + entry.intervalMs;
      this.emit('rotation:completed', { identityId });
    } catch (err) {
      entry.failureCount++;
      const backoff = Math.min(entry.intervalMs, Math.pow(2, entry.failureCount) * 1000);
      entry.nextRotation = Date.now() + backoff;
      this.emit('rotation:failed', { identityId, error: (err as Error).message, failureCount: entry.failureCount });
    }

    this.startTimer(entry);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const entries = Array.from(this.schedules.values());
    await this.vault.store(this.vaultKey, JSON.stringify(entries));
  }
}
