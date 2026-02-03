/**
 * Global Kuramoto Engine
 *
 * Network-wide phase synchronization with TTL enforcement,
 * adaptive coupling, and flood attack detection.
 */

import { KuramotoEngine, type KuramotoConfig, type Oscillator } from './kuramoto.js';
import type { Observer } from '../primitives/types.js';

export interface GlobalKuramotoConfig extends KuramotoConfig {
  broadcastHz: number;
  staleTTL: number;
  adaptiveCoupling: boolean;
  minCoupling: number;
  maxCoupling: number;
  groupthinkThreshold: number;
}

const DEFAULT_GLOBAL_CONFIG: GlobalKuramotoConfig = {
  frequencyVariance: 0.1,
  couplingStrength: 0.5,
  targetCoherence: 0.8,
  coherenceThreshold: 0.3,
  dt: 100,
  broadcastHz: 1,
  staleTTL: 30000,
  adaptiveCoupling: true,
  minCoupling: 0.1,
  maxCoupling: 1.5,
  groupthinkThreshold: 0.95,
};

interface NetworkOscillator {
  id: string;
  lastReported: number;
  networkLatency: number;
  trustScore: number;
}

export class GlobalKuramotoEngine {
  private engine: KuramotoEngine;
  private config: GlobalKuramotoConfig;
  private networkMeta: Map<string, NetworkOscillator> = new Map();
  private reportCounts: Map<string, number[]> = new Map(); // agentId → timestamps
  private currentCoupling: number;

  constructor(config?: Partial<GlobalKuramotoConfig>) {
    this.config = { ...DEFAULT_GLOBAL_CONFIG, ...config };
    this.engine = new KuramotoEngine(this.config);
    this.currentCoupling = this.config.couplingStrength;
  }

  reportPhase(agentId: string, phase: number, timestamp: number): void {
    if (this.detectFloodAttack(agentId)) return;

    const meta = this.networkMeta.get(agentId);
    if (meta) {
      meta.lastReported = Date.now();
      meta.networkLatency = Date.now() - timestamp;
    }

    // Update oscillator phase directly
    const oscillators = this.engine.getOscillators();
    const osc = oscillators.find(o => o.id === agentId);
    if (osc) {
      osc.phase = phase;
      osc.observer.phase = phase;
    }
  }

  addAgent(observer: { id: string; name: string; frequency: number; phase: number }): void {
    this.engine.addObserver({
      id: observer.id,
      name: observer.name,
      frequency: observer.frequency,
      layer: 2,
      collapseRate: 100,
      darkSensitivity: 0.5,
      phase: observer.phase,
    });

    this.networkMeta.set(observer.id, {
      id: observer.id,
      lastReported: Date.now(),
      networkLatency: 0,
      trustScore: 1.0,
    });
  }

  removeAgent(agentId: string): void {
    this.engine.removeObserver(agentId);
    this.networkMeta.delete(agentId);
    this.reportCounts.delete(agentId);
  }

  tick(): { coherence: number; phases: Map<string, number>; adaptedK: number } {
    const result = this.engine.tick();

    if (this.config.adaptiveCoupling) {
      this.adaptCoupling(result.coherence);
    }

    return { ...result, adaptedK: this.currentCoupling };
  }

  private adaptCoupling(coherence: number): void {
    if (coherence < this.config.coherenceThreshold) {
      this.currentCoupling = Math.min(
        this.config.maxCoupling,
        this.currentCoupling + 0.05
      );
    } else if (coherence > this.config.groupthinkThreshold) {
      this.currentCoupling = Math.max(
        this.config.minCoupling,
        this.currentCoupling - 0.05
      );
    }

    this.engine.setCouplingStrength(this.currentCoupling);
  }

  pruneStale(): string[] {
    const now = Date.now();
    const removed: string[] = [];

    for (const [id, meta] of this.networkMeta) {
      if (now - meta.lastReported > this.config.staleTTL) {
        this.removeAgent(id);
        removed.push(id);
      }
    }

    return removed;
  }

  getCoherenceField(): {
    coherence: number;
    meanPhase: number;
    agentCount: number;
    coupling: number;
  } {
    return {
      coherence: this.engine.getCoherence(),
      meanPhase: this.engine.getMeanPhase(),
      agentCount: this.networkMeta.size,
      coupling: this.currentCoupling,
    };
  }

  detectFloodAttack(agentId: string): boolean {
    const now = Date.now();
    const timestamps = this.reportCounts.get(agentId) ?? [];
    const recent = timestamps.filter(t => now - t < 1000);
    recent.push(now);
    this.reportCounts.set(agentId, recent);

    if (recent.length > 10) {
      const meta = this.networkMeta.get(agentId);
      if (meta) meta.trustScore = Math.max(0, meta.trustScore - 0.1);
      return true;
    }
    return false;
  }

  // Compatibility methods for drop-in replacement of KuramotoEngine in server.ts

  addObserver(observer: Observer): void {
    this.addAgent({
      id: observer.id,
      name: observer.name,
      frequency: observer.frequency,
      phase: observer.phase,
    });
  }

  removeObserver(id: string): void {
    this.removeAgent(id);
  }

  getCoherence(): number {
    return this.engine.getCoherence();
  }

  getMeanPhase(): number {
    return this.engine.getMeanPhase();
  }

  getNetworkTopology(): Array<{
    id: string;
    phase: number;
    frequency: number;
    trust: number;
  }> {
    return this.engine.getOscillators().map(osc => {
      const meta = this.networkMeta.get(osc.id);
      return {
        id: osc.id,
        phase: osc.phase,
        frequency: osc.naturalFrequency,
        trust: meta?.trustScore ?? 0,
      };
    });
  }

  getStats() {
    return this.engine.getStats();
  }

  needsIntervention(): boolean {
    return this.engine.needsIntervention();
  }

  forceSynchronize(): void {
    this.engine.forceSynchronize();
  }
}

export function createGlobalKuramoto(
  config?: Partial<GlobalKuramotoConfig>
): GlobalKuramotoEngine {
  return new GlobalKuramotoEngine(config);
}
