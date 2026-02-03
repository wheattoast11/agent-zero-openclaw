import { randomUUID } from 'crypto';
import { ThermodynamicRouter, cosineSimilarity } from './thermodynamic.js';

/**
 * Attractor basin in the distributed energy landscape.
 * Represents a semantic cluster that attracts related messages.
 */
export interface AttractorBasin {
  id: string;
  centroid: number[]; // 768-dim embedding
  mass: number; // Semantic mass (sum of resonance)
  agentCount: number; // Number of agents in this basin
  topicLabel: string; // Human-readable topic
}

/**
 * Snapshot of energy landscape for gossip protocol.
 */
export interface EnergyLandscapeSnapshot {
  basins: AttractorBasin[];
  timestamp: number;
  nodeId: string;
}

/**
 * Configuration for distributed router.
 */
export interface DistributedRouterConfig {
  gossipInterval: number; // ms between gossip broadcasts
  syncThreshold: number; // Min similarity to merge basins
  maxBasins: number; // Max basins before forced merge
  splitThreshold: number; // Max agents before recommending split
  mergeThreshold: number; // Min cosine similarity to merge
}

const DEFAULT_CONFIG: DistributedRouterConfig = {
  gossipInterval: 5000,
  syncThreshold: 0.85,
  maxBasins: 50,
  splitThreshold: 10,
  mergeThreshold: 0.92,
};

/**
 * Distributed thermodynamic router using gossip protocol.
 * Shares energy landscape across rail network for global coherence.
 */
export class DistributedRouter {
  private basins = new Map<string, AttractorBasin>();
  private config: DistributedRouterConfig;
  private nodeId = randomUUID();

  constructor(
    private localRouter: ThermodynamicRouter,
    config?: Partial<DistributedRouterConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  addBasin(basin: AttractorBasin): void {
    this.basins.set(basin.id, basin);
    this.enforceMaxBasins();
  }

  removeBasin(id: string): void {
    this.basins.delete(id);
  }

  /**
   * Merge remote landscape snapshot via gossip protocol.
   * Weighted average for existing basins, add new ones, keep local-only.
   */
  receiveGossip(snapshot: EnergyLandscapeSnapshot): void {
    const remoteBasinIds = new Set(snapshot.basins.map((b) => b.id));

    for (const remoteBasin of snapshot.basins) {
      const local = this.basins.get(remoteBasin.id);

      if (local) {
        // Weighted average: local mass vs remote mass
        const totalMass = local.mass + remoteBasin.mass;
        const localWeight = local.mass / totalMass;
        const remoteWeight = remoteBasin.mass / totalMass;

        const mergedCentroid = local.centroid.map(
          (val, i) => val * localWeight + remoteBasin.centroid[i] * remoteWeight
        );

        this.basins.set(remoteBasin.id, {
          ...local,
          centroid: mergedCentroid,
          mass: totalMass,
          agentCount: local.agentCount + remoteBasin.agentCount,
        });
      } else {
        // New basin from remote
        this.basins.set(remoteBasin.id, { ...remoteBasin });
      }
    }

    // Keep local basins not in remote (don't delete)
    this.enforceMaxBasins();
  }

  getGossipPayload(): EnergyLandscapeSnapshot {
    return {
      basins: Array.from(this.basins.values()),
      timestamp: Date.now(),
      nodeId: this.nodeId,
    };
  }

  /**
   * Route embedding to highest-affinity basin.
   */
  routeToBasin(embedding: number[]): AttractorBasin | null {
    if (this.basins.size === 0) return null;

    let bestBasin: AttractorBasin | null = null;
    let maxAffinity = -Infinity;

    for (const basin of this.basins.values()) {
      const affinity = cosineSimilarity(embedding, basin.centroid);
      if (affinity > maxAffinity) {
        maxAffinity = affinity;
        bestBasin = basin;
      }
    }

    return bestBasin;
  }

  /**
   * Check if basin should split due to high agent count.
   */
  checkSplit(basinId: string): boolean {
    const basin = this.basins.get(basinId);
    return basin ? basin.agentCount > this.config.splitThreshold : false;
  }

  /**
   * Split basin into two by perturbing centroid.
   */
  splitBasin(basinId: string): [AttractorBasin, AttractorBasin] {
    const basin = this.basins.get(basinId);
    if (!basin) throw new Error(`Basin ${basinId} not found`);

    const perturbation = basin.centroid.map(() => (Math.random() - 0.5) * 0.1);
    const centroid1 = basin.centroid.map((v, i) => v + perturbation[i]);
    const centroid2 = basin.centroid.map((v, i) => v - perturbation[i]);

    const basin1: AttractorBasin = {
      id: randomUUID(),
      centroid: centroid1,
      mass: basin.mass / 2,
      agentCount: Math.floor(basin.agentCount / 2),
      topicLabel: `${basin.topicLabel}-A`,
    };

    const basin2: AttractorBasin = {
      id: randomUUID(),
      centroid: centroid2,
      mass: basin.mass / 2,
      agentCount: Math.ceil(basin.agentCount / 2),
      topicLabel: `${basin.topicLabel}-B`,
    };

    this.basins.delete(basinId);
    this.basins.set(basin1.id, basin1);
    this.basins.set(basin2.id, basin2);

    return [basin1, basin2];
  }

  /**
   * Merge basins with cosine similarity above threshold.
   */
  mergeSimilarBasins(threshold?: number): number {
    const mergeThreshold = threshold ?? this.config.mergeThreshold;
    const basinsArray = Array.from(this.basins.values());
    let mergeCount = 0;

    for (let i = 0; i < basinsArray.length; i++) {
      for (let j = i + 1; j < basinsArray.length; j++) {
        const similarity = cosineSimilarity(
          basinsArray[i].centroid,
          basinsArray[j].centroid
        );

        if (similarity >= mergeThreshold) {
          const merged = this.mergeTwo(basinsArray[i], basinsArray[j]);
          this.basins.delete(basinsArray[i].id);
          this.basins.delete(basinsArray[j].id);
          this.basins.set(merged.id, merged);
          mergeCount++;
          // Remove merged basins from array to avoid double-merge
          basinsArray.splice(j, 1);
          basinsArray.splice(i, 1);
          i--;
          break;
        }
      }
    }

    return mergeCount;
  }

  /**
   * Seed attractor basins for Agent Zero topics.
   */
  seedAgentZeroAttractors(topics: string[]): void {
    for (const topic of topics) {
      const centroid = this.generateTopicEmbedding(topic);
      this.addBasin({
        id: randomUUID(),
        centroid,
        mass: 1.0,
        agentCount: 1,
        topicLabel: topic,
      });
    }
  }

  getBasins(): AttractorBasin[] {
    return Array.from(this.basins.values());
  }

  getStats(): { basinCount: number; totalMass: number; largestBasin: string } {
    const basins = this.getBasins();
    const totalMass = basins.reduce((sum, b) => sum + b.mass, 0);
    const largest = basins.reduce(
      (max, b) => (b.mass > max.mass ? b : max),
      basins[0] ?? { mass: 0, topicLabel: 'none' }
    );

    return {
      basinCount: basins.length,
      totalMass,
      largestBasin: largest.topicLabel,
    };
  }

  private mergeTwo(a: AttractorBasin, b: AttractorBasin): AttractorBasin {
    const totalMass = a.mass + b.mass;
    const centroid = a.centroid.map(
      (v, i) => (v * a.mass + b.centroid[i] * b.mass) / totalMass
    );

    return {
      id: randomUUID(),
      centroid,
      mass: totalMass,
      agentCount: a.agentCount + b.agentCount,
      topicLabel: `${a.topicLabel}+${b.topicLabel}`,
    };
  }

  private enforceMaxBasins(): void {
    while (this.basins.size > this.config.maxBasins) {
      this.mergeSimilarBasins(this.config.mergeThreshold);
    }
  }

  private generateTopicEmbedding(topic: string): number[] {
    // Simple hash-based embedding for seeding (production would use real embeddings)
    const hash = topic.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0);
    const rng = this.seededRandom(hash);
    return Array.from({ length: 768 }, () => (rng() - 0.5) * 2);
  }

  private seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 2 ** 32;
      return state / 2 ** 32;
    };
  }
}

/**
 * Factory for distributed router.
 */
export function createDistributedRouter(
  localRouter: ThermodynamicRouter,
  config?: Partial<DistributedRouterConfig>
): DistributedRouter {
  return new DistributedRouter(localRouter, config);
}
