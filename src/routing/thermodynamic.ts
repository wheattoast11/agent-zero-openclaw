/**
 * Thermodynamic Router
 *
 * Routes messages by minimizing free energy through Boltzmann sampling.
 * Physical routing ≅ semantic routing.
 *
 * F = E[log p(y|x,model)] - H[q(model)]
 * Lower energy = better semantic fit
 * Temperature controls exploration vs exploitation
 */

import type { Observer, Message, Fabric, FabricNode, GravityWell } from '../primitives/types.js';

/** Minimum temperature to prevent degenerate Boltzmann distributions */
export const MIN_TEMPERATURE = 0.01;

export interface RouterConfig {
  /** Base temperature for Boltzmann sampling */
  temperature: number;
  /** Weight for load penalty */
  loadWeight: number;
  /** Weight for coherence bonus */
  coherenceWeight: number;
  /** Weight for semantic distance */
  semanticWeight: number;
  /** Weight for model affinity bonus (default 0) */
  modelWeight?: number;
  /** Annealing schedule */
  annealingSchedule: 'none' | 'linear' | 'exponential' | 'adaptive';
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  temperature: 1.0,
  loadWeight: 0.2,
  coherenceWeight: 0.2,
  semanticWeight: 0.3,
  modelWeight: 0.3,
  annealingSchedule: 'adaptive',
};

/**
 * Compute energy for routing a message to a specific agent.
 * Lower energy = higher probability of selection.
 *
 * Model affinity is an optional bonus: when the model's identity embedding
 * is semantically close to the message, energy decreases (better fit).
 */
export function computeEnergy(
  messageEmbedding: number[],
  agent: Observer,
  agentLoad: number,
  agentCoherence: number,
  agentAttractor: number[],
  config: RouterConfig,
  modelEmbedding?: number[]
): number {
  // Semantic distance (cosine similarity inverted)
  const semanticDistance = 1 - cosineSimilarity(messageEmbedding, agentAttractor);

  // Load penalty (busy agents cost more)
  const loadPenalty = agentLoad * config.loadWeight;

  // Coherence bonus (aligned agents cost less)
  const coherenceBonus = agentCoherence * config.coherenceWeight;

  // Model affinity bonus: how well does the model's identity match the task?
  const modelAffinity = modelEmbedding
    ? cosineSimilarity(messageEmbedding, modelEmbedding) * (config.modelWeight ?? 0)
    : 0;

  // Total energy (affinity is a bonus, so subtracted)
  return (semanticDistance * config.semanticWeight) + loadPenalty - coherenceBonus - modelAffinity;
}

/**
 * Softmax with temperature for Boltzmann distribution
 */
export function softmax(energies: number[], temperature: number): number[] {
  // Floor temperature to prevent division by zero / degenerate distributions
  const T = Math.max(MIN_TEMPERATURE, temperature);
  // Negate energies (lower energy = higher probability)
  const negEnergies = energies.map(e => -e / T);

  // Numerical stability: subtract max
  const maxE = Math.max(...negEnergies);
  const exps = negEnergies.map(e => Math.exp(e - maxE));
  const sum = exps.reduce((a, b) => a + b, 0);

  return exps.map(e => e / sum);
}

/**
 * Sample from probability distribution
 */
export function sample<T>(items: T[], probabilities: number[]): T {
  const r = Math.random();
  let cumulative = 0;

  for (let i = 0; i < items.length; i++) {
    cumulative += probabilities[i];
    if (r <= cumulative) {
      return items[i];
    }
  }

  return items[items.length - 1];
}

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Find nearest gravity well to an embedding
 */
export function findNearestWell(
  embedding: number[],
  wells: GravityWell[]
): GravityWell | null {
  if (wells.length === 0) return null;

  let nearest: GravityWell | null = null;
  let maxSimilarity = -Infinity;

  for (const well of wells) {
    const similarity = cosineSimilarity(embedding, well.centroid);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      nearest = well;
    }
  }

  return nearest;
}

/**
 * Main thermodynamic router class
 */
export class ThermodynamicRouter {
  private config: RouterConfig;
  private temperature: number;
  private step: number = 0;

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.temperature = this.config.temperature;
  }

  /**
   * Route a message to the optimal agent using thermodynamic sampling.
   * Agents may optionally carry a modelEmbedding for model-affinity routing.
   */
  route(
    message: Message,
    agents: Array<{
      observer: Observer;
      load: number;
      coherence: number;
      attractor: number[];
      modelEmbedding?: number[];
    }>
  ): Observer {
    if (agents.length === 0) {
      throw new Error('No agents available for routing');
    }

    if (agents.length === 1) {
      return agents[0].observer;
    }

    const messageEmbedding = message.embedding ?? new Array(768).fill(0);

    // Compute energies for all agents
    const energies = agents.map(agent =>
      computeEnergy(
        messageEmbedding,
        agent.observer,
        agent.load,
        agent.coherence,
        agent.attractor,
        this.config,
        agent.modelEmbedding
      )
    );

    // Convert to probabilities via Boltzmann distribution
    const probabilities = softmax(energies, this.temperature);

    // Sample from distribution
    const selectedAgent = sample(agents, probabilities);

    // Update temperature according to annealing schedule
    this.anneal();

    return selectedAgent.observer;
  }

  /**
   * Get energy landscape for visualization
   */
  energyLandscape(
    message: Message,
    agents: Array<{
      observer: Observer;
      load: number;
      coherence: number;
      attractor: number[];
      modelEmbedding?: number[];
    }>
  ): Map<string, { energy: number; probability: number }> {
    const messageEmbedding = message.embedding ?? new Array(768).fill(0);

    const energies = agents.map(agent =>
      computeEnergy(
        messageEmbedding,
        agent.observer,
        agent.load,
        agent.coherence,
        agent.attractor,
        this.config,
        agent.modelEmbedding
      )
    );

    const probabilities = softmax(energies, this.temperature);

    const landscape = new Map<string, { energy: number; probability: number }>();
    for (let i = 0; i < agents.length; i++) {
      landscape.set(agents[i].observer.id, {
        energy: energies[i],
        probability: probabilities[i],
      });
    }

    return landscape;
  }

  /**
   * Apply annealing schedule
   */
  private anneal(): void {
    this.step++;

    switch (this.config.annealingSchedule) {
      case 'linear':
        this.temperature = Math.max(0.01, this.config.temperature - this.step * 0.001);
        break;
      case 'exponential':
        this.temperature = Math.max(MIN_TEMPERATURE, this.config.temperature * Math.pow(0.999, this.step));
        break;
      case 'adaptive':
        // Temperature adapts based on routing diversity
        // (would need external coherence signal in production)
        break;
      case 'none':
      default:
        // No annealing
        break;
    }
  }

  /**
   * Set temperature directly (for adaptive control)
   */
  setTemperature(temp: number): void {
    this.temperature = Math.max(MIN_TEMPERATURE, temp);
  }

  /**
   * Get current temperature
   */
  getTemperature(): number {
    return this.temperature;
  }

  /**
   * Reset router state
   */
  reset(): void {
    this.step = 0;
    this.temperature = this.config.temperature;
  }
}
