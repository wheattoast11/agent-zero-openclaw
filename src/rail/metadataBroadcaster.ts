/**
 * Metadata Broadcaster
 *
 * Aggregates rail subsystem state every 2s and broadcasts to observers.
 * Supports delta encoding — only changed fields are sent.
 * Full snapshot every 10th cycle.
 */

import type { ResonanceRailServer, RailClient } from './server.js';
import type { KuramotoEngine } from '../resonance/kuramoto.js';
import type { ThermodynamicRouter } from '../routing/thermodynamic.js';
import type { SecurityMonitor } from './securityMonitor.js';
import type { AbsorptionBridge } from './absorptionBridge.js';

export interface RailMetadata {
  type: 'metadata';
  full: boolean;
  energyLandscape?: Record<string, { energy: number; probability: number }>;
  routerTemperature?: number;
  trustScores?: Record<string, { stage: string; couplingStrength: number }>;
  securityStats?: Record<string, number>;
  coherenceField?: {
    oscillators: Array<{ id: string; phase: number }>;
    globalR: number;
    meanPhase: number;
  };
  platformStats?: Record<string, number>;
  absorptionStats?: Record<string, number>;
  externalAgentCount?: number;
  timestamp: number;
}

export interface MetadataBroadcasterConfig {
  intervalMs: number;
  fullSnapshotEvery: number;
}

const DEFAULT_CONFIG: MetadataBroadcasterConfig = {
  intervalMs: 2000,
  fullSnapshotEvery: 10,
};

export class MetadataBroadcaster {
  private config: MetadataBroadcasterConfig;
  private rail: ResonanceRailServer;
  private broadcastFn: (msg: unknown) => void;
  private timer?: ReturnType<typeof setInterval>;
  private cycleCount = 0;
  private previousSnapshot: Omit<RailMetadata, 'type' | 'full' | 'timestamp'> | null = null;

  constructor(
    rail: ResonanceRailServer,
    broadcastFn: (msg: unknown) => void,
    config?: Partial<MetadataBroadcasterConfig>,
  ) {
    this.rail = rail;
    this.broadcastFn = broadcastFn;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.timer = setInterval(() => this.broadcast(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private broadcast(): void {
    this.cycleCount++;
    const isFull = this.cycleCount % this.config.fullSnapshotEvery === 0;

    const snapshot = this.collectSnapshot();
    const msg: RailMetadata = {
      type: 'metadata',
      full: isFull,
      timestamp: Date.now(),
    };

    if (isFull || !this.previousSnapshot) {
      Object.assign(msg, snapshot);
    } else {
      // Delta: only include changed fields
      for (const key of Object.keys(snapshot) as Array<keyof typeof snapshot>) {
        const current = JSON.stringify(snapshot[key]);
        const previous = JSON.stringify(this.previousSnapshot[key]);
        if (current !== previous) {
          (msg as unknown as Record<string, unknown>)[key] = snapshot[key];
        }
      }
    }

    this.previousSnapshot = snapshot;
    this.broadcastFn(msg);
  }

  private collectSnapshot(): Omit<RailMetadata, 'type' | 'full' | 'timestamp'> {
    const clients = this.rail.getClients();
    const stats = this.rail.getStats();
    const coherenceStats = this.rail.getCoherenceStats();
    const securityStats = this.rail.getSecurityStats(60_000);

    // Energy landscape — simplified (no active message to route against)
    const energyLandscape: Record<string, { energy: number; probability: number }> = {};
    if (clients.length > 0) {
      const uniform = 1 / clients.length;
      for (const c of clients) {
        energyLandscape[c.agentId] = {
          energy: 1 - c.coherenceContribution,
          probability: uniform,
        };
      }
    }

    // Trust scores from absorption bridge
    const trustScores: Record<string, { stage: string; couplingStrength: number }> = {};
    const bridge = this.rail.getAbsorptionBridge();
    if (bridge) {
      for (const c of clients) {
        const cap = bridge.getCapabilityToken(c.agentId);
        trustScores[c.agentId] = {
          stage: cap ? 'connected' : 'observed',
          couplingStrength: c.coherenceContribution,
        };
      }
    }

    // Coherence field from Kuramoto
    const oscillators: Array<{ id: string; phase: number }> = clients.map(c => ({
      id: c.agentId,
      phase: c.phase,
    }));

    // Platform stats
    const platformStats: Record<string, number> = {};
    for (const c of clients) {
      platformStats[c.platform] = (platformStats[c.platform] ?? 0) + 1;
    }

    // Absorption stats
    const absorptionStats: Record<string, number> = {};
    const bridgeInstance = this.rail.getAbsorptionBridge();
    if (bridgeInstance) {
      // Count agents by absorption stage from trust scores
      for (const score of Object.values(trustScores)) {
        absorptionStats[score.stage] = (absorptionStats[score.stage] ?? 0) + 1;
      }
    }

    // External agent count (not browser-runtime users)
    const externalAgentCount = clients.filter(c => c.platform !== 'browser-runtime' && c.platform !== 'observer').length;

    return {
      energyLandscape,
      routerTemperature: 0.8,
      trustScores,
      securityStats: securityStats as Record<string, number>,
      coherenceField: {
        oscillators,
        globalR: stats.globalCoherence,
        meanPhase: coherenceStats?.current ?? 0,
      },
      platformStats,
      absorptionStats,
      externalAgentCount,
    };
  }
}

export function createMetadataBroadcaster(
  rail: ResonanceRailServer,
  broadcastFn: (msg: unknown) => void,
  config?: Partial<MetadataBroadcasterConfig>,
): MetadataBroadcaster {
  return new MetadataBroadcaster(rail, broadcastFn, config);
}
