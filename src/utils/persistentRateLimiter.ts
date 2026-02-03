/**
 * Persistent Rate Limiter
 *
 * Rate limiting with persistent storage via Vault.
 * Survives process restarts and shares state across instances.
 */

import { Vault } from '../security/vault.js';

interface WindowState {
  timestamps: number[];
}

/**
 * Sliding window rate limiter with persistent storage.
 * Stores request timestamps in vault and debounces writes for performance.
 */
export class PersistentSlidingWindowLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;
  private vault: Vault;
  private vaultKey: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(vault: Vault, key: string, maxRequests: number, windowMs: number) {
    this.vault = vault;
    this.vaultKey = `ratelimit:${key}`;
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Load persisted state from vault.
   * Must be called before using the limiter.
   */
  async load(): Promise<void> {
    const stored = await this.vault.retrieve(this.vaultKey);
    if (stored) {
      const state: WindowState = JSON.parse(stored);
      // Prune stale timestamps on load
      this.timestamps = state.timestamps.filter(t => Date.now() - t < this.windowMs);
    }

    // Debounced persist every 5s to reduce I/O
    this.persistTimer = setInterval(() => void this.flush(), 5000);
  }

  /**
   * Check if a request is allowed and record it.
   * @returns true if request is allowed, false if rate limit exceeded
   */
  allow(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }

    this.timestamps.push(now);
    this.dirty = true;
    return true;
  }

  /**
   * Get remaining request quota.
   */
  remaining(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  /**
   * Force persist current state to vault.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    await this.vault.store(this.vaultKey, JSON.stringify({ timestamps: this.timestamps }));
  }

  /**
   * Clean up resources and persist final state.
   */
  async destroy(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush();
  }
}

/**
 * Cooldown-based rate limiter with persistent storage.
 * Enforces minimum time between actions.
 */
export class PersistentCooldownLimiter {
  private lastAction = 0;
  private cooldownMs: number;
  private vault: Vault;
  private vaultKey: string;

  constructor(vault: Vault, key: string, cooldownMs: number) {
    this.vault = vault;
    this.vaultKey = `cooldown:${key}`;
    this.cooldownMs = cooldownMs;
  }

  /**
   * Load persisted state from vault.
   * Must be called before using the limiter.
   */
  async load(): Promise<void> {
    const stored = await this.vault.retrieve(this.vaultKey);
    if (stored) {
      const state = JSON.parse(stored);
      this.lastAction = state.lastAction || 0;
    }
  }

  /**
   * Check if an action is allowed and record it.
   * @returns true if action is allowed, false if still in cooldown
   */
  async allow(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastAction < this.cooldownMs) {
      return false;
    }

    this.lastAction = now;
    await this.vault.store(this.vaultKey, JSON.stringify({ lastAction: this.lastAction }));
    return true;
  }

  /**
   * Get remaining cooldown time in milliseconds.
   */
  remainingMs(): number {
    return Math.max(0, this.cooldownMs - (Date.now() - this.lastAction));
  }
}
