/**
 * @terminals-tech/agent-zero/resonance
 *
 * Kuramoto phase synchronization, global coherence, absorption protocol.
 */

export {
  KuramotoEngine,
  computeCoherence,
  computeMeanPhase,
  evolvePhase,
  DEFAULT_KURAMOTO_CONFIG,
} from './kuramoto.js';

export type { KuramotoConfig, Oscillator } from './kuramoto.js';

export { GlobalKuramotoEngine, createGlobalKuramoto } from './globalKuramoto.js';
export type { GlobalKuramotoConfig } from './globalKuramoto.js';

export { AbsorptionProtocol, AbsorptionStage, createAbsorptionProtocol } from '../coherence/absorption.js';
export type { AbsorptionConfig, AbsorptionCandidate, BehaviorSignals, AbsorptionStats } from '../coherence/absorption.js';
