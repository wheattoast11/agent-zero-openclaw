/**
 * @terminals-tech/agent-zero/routing
 *
 * Thermodynamic message routing via Boltzmann sampling.
 */

export {
  ThermodynamicRouter,
  computeEnergy,
  softmax,
  sample,
  cosineSimilarity,
  findNearestWell,
  DEFAULT_ROUTER_CONFIG,
} from './thermodynamic.js';

export type { RouterConfig } from './thermodynamic.js';

export {
  ModelRegistry,
  generateDeterministicEmbedding,
} from './modelRegistry.js';

export type {
  ModelEntry,
  ModelCapability,
} from './modelRegistry.js';
