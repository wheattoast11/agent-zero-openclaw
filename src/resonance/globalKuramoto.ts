/**
 * Global Kuramoto Engine
 *
 * Network-wide phase synchronization with TTL enforcement,
 * adaptive coupling, and flood attack detection.
 */

import { KuramotoEngine, computeCoherence, type KuramotoConfig, type Oscillator } from './kuramoto.js';
import type { Observer } from '../primitives/types.js';

export interface GlobalKuramotoConfig extends KuramotoConfig {
  broadcastHz: number;
  staleTTL: number;
  adaptiveCoupling: boolean;
  minCoupling: number;
  maxCoupling: number;
  groupthinkThreshold: number;
  /** Cross-model coupling factor: cross-model pairs couple at K * this factor (default 0.7) */
  crossModelCouplingFactor: number;
}

const DEFAULT_GLOBAL_CONFIG: GlobalKuramotoConfig = {
  frequencyVariance: 0.1,
  couplingStrength: 0.5,
  targetCoherence: 0.8,
  coherenceThreshold: 0.3,
  dt: 100,
  convergenceTimeoutTicks: 300,
  convergenceMinDelta: 0.01,
  broadcastHz: 1,
  staleTTL: 30000,
  adaptiveCoupling: true,
  minCoupling: 0.1,
  maxCoupling: 1.5,
  groupthinkThreshold: 0.95,
  crossModelCouplingFactor: 0.7,
};

interface NetworkOscillator {
  id: string;
  lastReported: number;
  networkLatency: number;
  trustScore: number;
  modelType?: string;
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

  addAgent(observer: { id: string; name: string; frequency: number; phase: number; modelType?: string }): void {
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
      modelType: observer.modelType,
    });
  }

  removeAgent(agentId: string): void {
    this.engine.removeObserver(agentId);
    this.networkMeta.delete(agentId);
    this.reportCounts.delete(agentId);
  }

  tick(): { coherence: number; phases: Map<string, number>; adaptedK: number } {
    const result = this.engine.tick();

    // Post-tick: apply cross-model coupling reduction
    this.applyCrossModelCorrection();

    if (this.config.adaptiveCoupling) {
      this.adaptCoupling(result.coherence);
    }

    // Recompute coherence after correction
    const correctedCoherence = this.engine.getCoherence();

    return { coherence: correctedCoherence, phases: result.phases, adaptedK: this.currentCoupling };
  }

  /**
   * Apply reduced coupling between oscillators of different model types.
   * The base KuramotoEngine applies uniform coupling K to all pairs.
   * This post-tick step partially reverts phase changes from cross-model
   * pairs so they effectively couple at K * crossModelCouplingFactor.
   */
  private applyCrossModelCorrection(): void {
    const oscillators = this.engine.getOscillators();
    const factor = this.config.crossModelCouplingFactor ?? 0.7;
    const N = oscillators.length;

    // No correction needed if factor is 1 or fewer than 2 oscillators
    if (factor >= 1.0 || N < 2) return;

    // Check if any oscillators have model types assigned
    let hasModelTypes = false;
    for (const osc of oscillators) {
      const meta = this.networkMeta.get(osc.id);
      if (meta?.modelType) {
        hasModelTypes = true;
        break;
      }
    }
    if (!hasModelTypes) return;

    for (const osc of oscillators) {
      const meta = this.networkMeta.get(osc.id);
      if (!meta?.modelType) continue;

      let crossModelInfluence = 0;

      for (const other of oscillators) {
        if (other.id === osc.id) continue;
        const otherMeta = this.networkMeta.get(other.id);
        if (otherMeta?.modelType && otherMeta.modelType !== meta.modelType) {
          crossModelInfluence += Math.sin(other.phase - osc.phase);
        }
      }

      // The engine applied full coupling K/N * sin(diff) * dt to all pairs.
      // Cross-model pairs should only couple at factor * K, so revert (1-factor) portion.
      if (crossModelInfluence !== 0) {
        const revertAmount =
          (this.currentCoupling / N) *
          crossModelInfluence *
          (1 - factor) *
          (this.config.dt / 1000);
        osc.phase -= revertAmount;
        osc.observer.phase = osc.phase;
      }
    }
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

  /**
   * Calculate per-model-type Kuramoto order parameter.
   * Groups oscillators by modelType and computes coherence within each group.
   * Oscillators without a modelType are grouped under the key 'unknown'.
   */
  getCoherenceByModel(): Map<string, number> {
    const oscillators = this.engine.getOscillators();
    const groups = new Map<string, Oscillator[]>();

    for (const osc of oscillators) {
      const meta = this.networkMeta.get(osc.id);
      const modelType = meta?.modelType ?? 'unknown';
      const group = groups.get(modelType);
      if (group) {
        group.push(osc);
      } else {
        groups.set(modelType, [osc]);
      }
    }

    const result = new Map<string, number>();
    for (const [modelType, oscs] of groups) {
      result.set(modelType, computeCoherence(oscs));
    }
    return result;
  }

  /**
   * Check if any model-specific cluster exceeds the groupthink threshold.
   */
  getGroupthinkByModel(): Map<string, boolean> {
    const coherenceByModel = this.getCoherenceByModel();
    const result = new Map<string, boolean>();
    for (const [modelType, coherence] of coherenceByModel) {
      result.set(modelType, coherence > this.config.groupthinkThreshold);
    }
    return result;
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
