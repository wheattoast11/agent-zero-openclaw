/**
 * Kuramoto Coherence Engine
 *
 * Implements phase-locked synchronization for multi-agent coordination.
 * Based on the Kuramoto model of coupled oscillators.
 *
 * Order parameter: r = |Σ e^(iθ_j)| / N
 * r = 0: Complete incoherence (random phases)
 * r = 1: Perfect synchronization (all phases aligned)
 *
 * Target coherence for productive swarms: 0.7-0.9
 * Below 0.3: Intervention needed
 * Above 0.95: May indicate groupthink (reduce coupling)
 */

import type { Observer } from '../primitives/types.js';

export interface KuramotoConfig {
  /** Natural frequency variance (rad/s) */
  frequencyVariance: number;
  /** Base coupling strength */
  couplingStrength: number;
  /** Target coherence level */
  targetCoherence: number;
  /** Minimum coherence before intervention */
  coherenceThreshold: number;
  /** Time step for phase evolution (ms) */
  dt: number;
  /** Max ticks without meaningful convergence progress before auto-intervention */
  convergenceTimeoutTicks: number;
  /** Minimum coherence improvement per window to count as "progressing" */
  convergenceMinDelta: number;
}

export const DEFAULT_KURAMOTO_CONFIG: KuramotoConfig = {
  frequencyVariance: 0.1,
  couplingStrength: 0.5,
  targetCoherence: 0.8,
  coherenceThreshold: 0.3,
  dt: 16, // 60fps
  convergenceTimeoutTicks: 300, // ~5s at 60fps
  convergenceMinDelta: 0.01,
};

export interface Oscillator {
  id: string;
  /** Natural frequency (rad/s) */
  naturalFrequency: number;
  /** Current phase (0 to 2π) */
  phase: number;
  /** Associated observer */
  observer: Observer;
}

/**
 * Compute the Kuramoto order parameter
 * r = |Σ e^(iθ_j)| / N
 */
export function computeCoherence(oscillators: Oscillator[]): number {
  if (oscillators.length === 0) return 0;
  if (oscillators.length === 1) return 1;

  let sumCos = 0;
  let sumSin = 0;

  for (const osc of oscillators) {
    sumCos += Math.cos(osc.phase);
    sumSin += Math.sin(osc.phase);
  }

  return Math.sqrt(sumCos * sumCos + sumSin * sumSin) / oscillators.length;
}

/**
 * Compute the mean phase (Ψ in Kuramoto notation)
 */
export function computeMeanPhase(oscillators: Oscillator[]): number {
  if (oscillators.length === 0) return 0;

  let sumCos = 0;
  let sumSin = 0;

  for (const osc of oscillators) {
    sumCos += Math.cos(osc.phase);
    sumSin += Math.sin(osc.phase);
  }

  return Math.atan2(sumSin, sumCos);
}

/**
 * Kuramoto phase evolution: dθ_i/dt = ω_i + (K/N) Σ sin(θ_j - θ_i)
 */
export function evolvePhase(
  oscillator: Oscillator,
  allOscillators: Oscillator[],
  couplingStrength: number,
  dt: number
): number {
  const N = allOscillators.length;
  if (N <= 1) return oscillator.phase;

  // Sum of phase differences
  let coupling = 0;
  for (const other of allOscillators) {
    if (other.id !== oscillator.id) {
      coupling += Math.sin(other.phase - oscillator.phase);
    }
  }

  // Kuramoto equation
  const dTheta = oscillator.naturalFrequency + (couplingStrength / N) * coupling;

  // Euler integration
  let newPhase = oscillator.phase + dTheta * (dt / 1000);

  // Wrap to [0, 2π]
  while (newPhase < 0) newPhase += 2 * Math.PI;
  while (newPhase >= 2 * Math.PI) newPhase -= 2 * Math.PI;

  return newPhase;
}

/**
 * Main Kuramoto coherence engine
 */
export class KuramotoEngine {
  private config: KuramotoConfig;
  private oscillators: Map<string, Oscillator> = new Map();
  private coherenceHistory: number[] = [];
  private lastTick: number = 0;
  private stalledTicks: number = 0;
  private lastWindowCoherence: number = 0;

  constructor(config: Partial<KuramotoConfig> = {}) {
    this.config = { ...DEFAULT_KURAMOTO_CONFIG, ...config };
    this.lastTick = Date.now();
  }

  /**
   * Register an observer as an oscillator
   */
  addObserver(observer: Observer): void {
    // Generate natural frequency from observer's base frequency + variance
    const naturalFrequency =
      observer.frequency * (1 + (Math.random() - 0.5) * this.config.frequencyVariance);

    this.oscillators.set(observer.id, {
      id: observer.id,
      naturalFrequency,
      phase: observer.phase,
      observer,
    });
  }

  /**
   * Remove an observer from the engine
   */
  removeObserver(observerId: string): void {
    this.oscillators.delete(observerId);
  }

  /**
   * Tick the engine forward (evolve all phases)
   */
  tick(): { coherence: number; phases: Map<string, number> } {
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;

    const oscillatorList = Array.from(this.oscillators.values());

    // Evolve all phases
    const newPhases = new Map<string, number>();
    for (const osc of oscillatorList) {
      const newPhase = evolvePhase(
        osc,
        oscillatorList,
        this.config.couplingStrength,
        elapsed
      );
      newPhases.set(osc.id, newPhase);
    }

    // Update phases
    for (const [id, phase] of newPhases) {
      const osc = this.oscillators.get(id);
      if (osc) {
        osc.phase = phase;
        osc.observer.phase = phase;
      }
    }

    // Compute coherence
    const coherence = computeCoherence(oscillatorList);
    this.coherenceHistory.push(coherence);

    // Keep last 1000 samples
    if (this.coherenceHistory.length > 1000) {
      this.coherenceHistory.shift();
    }

    // Convergence stall detection: if coherence isn't improving, auto-intervene
    if (coherence < this.config.targetCoherence) {
      const delta = coherence - this.lastWindowCoherence;
      if (delta < this.config.convergenceMinDelta) {
        this.stalledTicks++;
      } else {
        this.stalledTicks = 0;
      }
      this.lastWindowCoherence = coherence;

      if (this.stalledTicks >= this.config.convergenceTimeoutTicks) {
        this.forceSynchronize();
        this.stalledTicks = 0;
      }
    } else {
      this.stalledTicks = 0;
      this.lastWindowCoherence = coherence;
    }

    return { coherence, phases: newPhases };
  }

  /**
   * Get current coherence
   */
  getCoherence(): number {
    return computeCoherence(Array.from(this.oscillators.values()));
  }

  /**
   * Get mean phase
   */
  getMeanPhase(): number {
    return computeMeanPhase(Array.from(this.oscillators.values()));
  }

  /**
   * Check if intervention is needed
   */
  needsIntervention(): boolean {
    return this.getCoherence() < this.config.coherenceThreshold;
  }

  /**
   * Force synchronization (intervention)
   */
  forceSynchronize(): void {
    const meanPhase = this.getMeanPhase();

    for (const osc of this.oscillators.values()) {
      // Nudge all oscillators toward mean phase
      const diff = meanPhase - osc.phase;
      osc.phase += diff * 0.5; // 50% correction
      osc.observer.phase = osc.phase;
    }
  }

  /**
   * Adjust coupling strength (for adaptive control)
   */
  setCouplingStrength(strength: number): void {
    this.config.couplingStrength = Math.max(0, Math.min(2, strength));
  }

  /**
   * Get coupling strength
   */
  getCouplingStrength(): number {
    return this.config.couplingStrength;
  }

  /**
   * Get coherence statistics
   */
  getStats(): {
    current: number;
    mean: number;
    min: number;
    max: number;
    variance: number;
  } {
    const history = this.coherenceHistory;
    if (history.length === 0) {
      return { current: 0, mean: 0, min: 0, max: 0, variance: 0 };
    }

    const current = this.getCoherence();
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const min = Math.min(...history);
    const max = Math.max(...history);
    const variance =
      history.reduce((acc, v) => acc + (v - mean) ** 2, 0) / history.length;

    return { current, mean, min, max, variance };
  }

  /**
   * Get all oscillator states
   */
  getOscillators(): Oscillator[] {
    return Array.from(this.oscillators.values());
  }

  /**
   * Reset engine
   */
  reset(): void {
    this.oscillators.clear();
    this.coherenceHistory = [];
    this.lastTick = Date.now();
    this.stalledTicks = 0;
    this.lastWindowCoherence = 0;
  }
}
