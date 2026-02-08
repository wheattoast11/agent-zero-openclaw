/**
 * @terminals-tech/agent-zero
 *
 * Secure primitives for autonomous systems.
 * Kuramoto coherence, thermodynamic routing, capability-based security.
 *
 * @package @terminals-tech/agent-zero
 * @version 2.0.0
 * @license MIT
 */

// ── Five Primitives (L1 types) ──────────────────────────────────────────────
export {
  Token, TokenPhase,
  Drift, isTemporalEcho,
  Fabric, FabricNode, FabricEdge, GravityWell,
  Observer, ObserverLayer, frequencyRatio,
  Realizability, AmbPoint,
  AgentZeroState, AgentState,
  Message, MessageKind,
} from './types.js';

// ── Security (cross-cutting) ────────────────────────────────────────────────
export { Vault, createVault } from '../security/vault.js';
export { IsomorphicSandbox, CapabilityScope, detectInjection, generateCapabilityToken } from '../security/sandbox.js';
export { SkillCapabilityManager, createSkillCapabilityManager } from '../security/capabilities.js';
export { InjectionFirewall, ParanoiaLevel, createFirewall } from '../security/injectionFirewall.js';
export {
  generateSigningKeyPair,
  signManifest,
  verifyManifest,
  verifySkillIntegrity,
} from '../security/skillVerify.js';

// ── Coordination (L3-L4) ───────────────────────────────────────────────────
export { KuramotoEngine, computeCoherence, computeMeanPhase } from '../resonance/kuramoto.js';
export { GlobalKuramotoEngine, createGlobalKuramoto } from '../resonance/globalKuramoto.js';
export { ThermodynamicRouter, computeEnergy, cosineSimilarity } from '../routing/thermodynamic.js';
export { AbsorptionProtocol, createAbsorptionProtocol } from '../coherence/absorption.js';

// ── v2: Model Registry ─────────────────────────────────────────────────────
export { ModelRegistry, generateDeterministicEmbedding } from '../routing/modelRegistry.js';
export type { ModelEntry, ModelCapability } from '../routing/modelRegistry.js';

// ── v2: Capability Combinators ──────────────────────────────────────────────
export {
  read, write, network, execute, memory, spawn,
  combine, restrict, withTTL, materialize,
  PROFILES,
} from '../security/combinators.js';
export type { CapabilityExpression } from '../security/combinators.js';

// ── Version ─────────────────────────────────────────────────────────────────
export const VERSION = '2.0.0';
export const RAIL_ENDPOINT = 'wss://space.terminals.tech/rail';
