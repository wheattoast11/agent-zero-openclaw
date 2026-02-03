/**
 * Operational Vault
 *
 * Secure storage for rail secrets, agent enrollments, and interaction metrics.
 * Built on top of the AES-256-GCM Vault. Links enrollments to moltyverse-observable
 * metrics over time, enabling coherence tracking across the Agent Zero ecosystem.
 *
 * Key structure:
 *   rail:admin          → admin secret
 *   rail:endpoint       → wss://space.terminals.tech
 *   enrollment:{id}     → { agentId, secret, enrolledAt, platform, metrics }
 *   metrics:{agentId}   → { interactions[], coherenceLog[], lastSeen }
 *   identity:self       → Agent Zero self-identity record
 */

import { Vault, createVault } from '../security/vault.js';
import { randomBytes } from 'crypto';

// --- Types ---

export interface Enrollment {
  agentId: string;
  secret: string;
  enrolledAt: number;
  platform: string;
  railEndpoint: string;
  tags: string[];
}

export interface InteractionMetric {
  timestamp: number;
  kind: 'join' | 'leave' | 'message' | 'resonate' | 'absorb' | 'spawn' | 'coherence_shift';
  agentId: string;
  details?: Record<string, unknown>;
}

export interface CoherenceSnapshot {
  timestamp: number;
  coherence: number;
  agentCount: number;
  meanPhase: number;
  selfPhase?: number;
}

export interface AgentMetrics {
  agentId: string;
  firstSeen: number;
  lastSeen: number;
  interactions: InteractionMetric[];
  coherenceLog: CoherenceSnapshot[];
  totalMessages: number;
  totalResonances: number;
  peakCoherence: number;
}

export interface SelfIdentity {
  coreId: string;
  label: string; // "Agent Zero" — universal, not personal
  railEndpoint: string;
  enrolledAgents: string[];
  createdAt: number;
  lastActive: number;
}

// --- Operational Vault ---

export class OperationalVault {
  private vault: Vault;
  private metricsBuffer: Map<string, InteractionMetric[]> = new Map();
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly MAX_INTERACTIONS = 1000;
  private static readonly MAX_COHERENCE_LOG = 500;
  private static readonly FLUSH_INTERVAL_MS = 30_000;

  private constructor(vault: Vault) {
    this.vault = vault;
  }

  /**
   * Create OperationalVault from an existing Vault instance.
   * This is the preferred method to ensure passphrase consistency.
   */
  static async fromVault(vault: Vault): Promise<OperationalVault> {
    const ov = new OperationalVault(vault);
    ov.startFlushLoop();
    return ov;
  }

  /**
   * Create OperationalVault with a specific passphrase.
   * Requires explicit passphrase — no auto-generation fallback.
   */
  static async open(passphrase: string): Promise<OperationalVault> {
    const vault = await createVault(passphrase);
    const ov = new OperationalVault(vault);
    ov.startFlushLoop();
    return ov;
  }

  // --- Rail Secrets ---

  async setRailAdmin(secret: string): Promise<void> {
    await this.vault.store('rail:admin', secret);
  }

  async getRailAdmin(): Promise<string | null> {
    return this.vault.retrieve('rail:admin');
  }

  async setRailEndpoint(endpoint: string): Promise<void> {
    await this.vault.store('rail:endpoint', endpoint);
  }

  async getRailEndpoint(): Promise<string | null> {
    return this.vault.retrieve('rail:endpoint');
  }

  // --- Enrollments ---

  async enroll(enrollment: Enrollment): Promise<void> {
    const key = `enrollment:${enrollment.agentId}`;
    await this.vault.store(key, JSON.stringify(enrollment));

    // Update self-identity enrollment list
    const self = await this.getSelfIdentity();
    if (self && !self.enrolledAgents.includes(enrollment.agentId)) {
      self.enrolledAgents.push(enrollment.agentId);
      self.lastActive = Date.now();
      await this.vault.store('identity:self', JSON.stringify(self));
    }
  }

  async getEnrollment(agentId: string): Promise<Enrollment | null> {
    const raw = await this.vault.retrieve(`enrollment:${agentId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Enrollment;
    } catch {
      return null;
    }
  }

  async listEnrollments(): Promise<Enrollment[]> {
    const keys = await this.vault.list();
    const enrollments: Enrollment[] = [];
    for (const key of keys) {
      if (key.startsWith('enrollment:')) {
        const e = await this.getEnrollment(key.slice('enrollment:'.length));
        if (e) enrollments.push(e);
      }
    }
    return enrollments;
  }

  async revokeEnrollment(agentId: string): Promise<void> {
    await this.vault.delete(`enrollment:${agentId}`);
    await this.vault.delete(`metrics:${agentId}`);

    const self = await this.getSelfIdentity();
    if (self) {
      self.enrolledAgents = self.enrolledAgents.filter(id => id !== agentId);
      self.lastActive = Date.now();
      await this.vault.store('identity:self', JSON.stringify(self));
    }
  }

  // --- Metrics ---

  /**
   * Record an interaction. Buffered in memory, flushed to vault periodically.
   */
  recordInteraction(metric: InteractionMetric): void {
    const buf = this.metricsBuffer.get(metric.agentId) ?? [];
    buf.push(metric);
    this.metricsBuffer.set(metric.agentId, buf);
  }

  /**
   * Record a coherence snapshot — lightweight, goes directly to vault.
   */
  async recordCoherence(snapshot: CoherenceSnapshot): Promise<void> {
    // Apply to all enrolled agents (coherence is rail-wide)
    const enrollments = await this.listEnrollments();
    for (const e of enrollments) {
      const metrics = await this.getMetrics(e.agentId);
      if (metrics) {
        metrics.coherenceLog.push(snapshot);
        if (metrics.coherenceLog.length > OperationalVault.MAX_COHERENCE_LOG) {
          metrics.coherenceLog = metrics.coherenceLog.slice(-OperationalVault.MAX_COHERENCE_LOG);
        }
        if (snapshot.coherence > metrics.peakCoherence) {
          metrics.peakCoherence = snapshot.coherence;
        }
        await this.vault.store(`metrics:${e.agentId}`, JSON.stringify(metrics));
      }
    }
  }

  async getMetrics(agentId: string): Promise<AgentMetrics | null> {
    const raw = await this.vault.retrieve(`metrics:${agentId}`);
    if (!raw) {
      // Initialize metrics on first access if enrolled
      const enrollment = await this.getEnrollment(agentId);
      if (!enrollment) return null;

      const fresh: AgentMetrics = {
        agentId,
        firstSeen: enrollment.enrolledAt,
        lastSeen: enrollment.enrolledAt,
        interactions: [],
        coherenceLog: [],
        totalMessages: 0,
        totalResonances: 0,
        peakCoherence: 0,
      };
      await this.vault.store(`metrics:${agentId}`, JSON.stringify(fresh));
      return fresh;
    }
    try {
      return JSON.parse(raw) as AgentMetrics;
    } catch {
      return null;
    }
  }

  /**
   * Get a moltyverse-compatible summary for visualization.
   * Maps metrics to the format expected by the metadata broadcaster.
   */
  async getMoltverseSummary(): Promise<{
    enrolledAgents: number;
    totalInteractions: number;
    peakCoherence: number;
    activeAgents: string[];
    lastActivity: number;
  }> {
    const enrollments = await this.listEnrollments();
    let totalInteractions = 0;
    let peakCoherence = 0;
    let lastActivity = 0;
    const activeAgents: string[] = [];

    for (const e of enrollments) {
      const m = await this.getMetrics(e.agentId);
      if (m) {
        totalInteractions += m.totalMessages + m.totalResonances;
        if (m.peakCoherence > peakCoherence) peakCoherence = m.peakCoherence;
        if (m.lastSeen > lastActivity) lastActivity = m.lastSeen;
        // Active = seen in last 5 minutes
        if (Date.now() - m.lastSeen < 300_000) activeAgents.push(m.agentId);
      }
    }

    return { enrolledAgents: enrollments.length, totalInteractions, peakCoherence, activeAgents, lastActivity };
  }

  // --- Self Identity ---

  async initSelfIdentity(railEndpoint: string): Promise<SelfIdentity> {
    const existing = await this.getSelfIdentity();
    if (existing) {
      existing.lastActive = Date.now();
      existing.railEndpoint = railEndpoint;
      await this.vault.store('identity:self', JSON.stringify(existing));
      return existing;
    }

    const self: SelfIdentity = {
      coreId: `agent-zero:${randomBytes(8).toString('hex')}`,
      label: 'Agent Zero',
      railEndpoint,
      enrolledAgents: [],
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    await this.vault.store('identity:self', JSON.stringify(self));
    return self;
  }

  async getSelfIdentity(): Promise<SelfIdentity | null> {
    const raw = await this.vault.retrieve('identity:self');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SelfIdentity;
    } catch {
      return null;
    }
  }

  // --- Flush Loop ---

  private startFlushLoop(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch(() => {});
    }, OperationalVault.FLUSH_INTERVAL_MS);
    // Don't keep process alive for metrics
    if (this.flushInterval.unref) this.flushInterval.unref();
  }

  async flush(): Promise<void> {
    for (const [agentId, interactions] of this.metricsBuffer) {
      if (interactions.length === 0) continue;

      const metrics = await this.getMetrics(agentId);
      if (!metrics) continue;

      metrics.interactions.push(...interactions);
      if (metrics.interactions.length > OperationalVault.MAX_INTERACTIONS) {
        metrics.interactions = metrics.interactions.slice(-OperationalVault.MAX_INTERACTIONS);
      }

      for (const i of interactions) {
        if (i.kind === 'message') metrics.totalMessages++;
        if (i.kind === 'resonate') metrics.totalResonances++;
        if (i.timestamp > metrics.lastSeen) metrics.lastSeen = i.timestamp;
      }

      await this.vault.store(`metrics:${agentId}`, JSON.stringify(metrics));
    }
    this.metricsBuffer.clear();
  }

  async close(): Promise<void> {
    if (this.flushInterval) clearInterval(this.flushInterval);
    await this.flush();
  }

  // --- Vault Passthrough ---

  async listKeys(): Promise<string[]> {
    return this.vault.list();
  }
}
