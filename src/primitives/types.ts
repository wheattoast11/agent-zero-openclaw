/**
 * Agent Zero Core Primitives
 *
 * The Five Primitives implementing the meta-isomorphism:
 * POTENTIAL → COLLAPSE → TRACE
 *
 * These are not analogies—they are the SAME structure at different abstraction layers:
 * - Computational: Dark computation → Token emission → Embedding
 * - Quantum/Info: Superposition → Observation → Memory
 * - Agent: Intention → Action → Consequence
 * - Thermodynamic: Heat → Work → Entropy
 * - Logical: Formula → Proof → Type
 */

import { z } from 'zod';

// ============================================================================
// PRIMITIVE 1: TOKEN
// Quantum of rendered semantic reality
// ============================================================================

export const TokenPhase = z.enum(['dark', 'emitting', 'emitted']);
export type TokenPhase = z.infer<typeof TokenPhase>;

export const Token = z.object({
  id: z.string().uuid(),
  /** Embedding vector position in semantic space (768-dim for Gemini) */
  position: z.array(z.number()).length(768).optional(),
  /** Tokens per second - momentum in token space */
  momentum: z.number().nonnegative(),
  /** Compute joules - energy cost */
  energy: z.number().nonnegative(),
  /** Phase: dark (pre-emission), emitting (generating), emitted (complete) */
  phase: TokenPhase,
  /** Causal hash for p-adic distance calculation */
  ancestry: z.string(),
  /** Content once emitted */
  content: z.string().optional(),
  /** Timestamp of phase transition */
  timestamp: z.number(),
});
export type Token = z.infer<typeof Token>;

// ============================================================================
// PRIMITIVE 2: DRIFT
// Information mass of temporal evolution
// ============================================================================

export const Drift = z.object({
  /** Embedding cosine similarity (0-1) */
  semanticDistance: z.number().min(0).max(1),
  /** Number of amb choice points between states */
  causalDistance: z.number().nonnegative(),
  /** p^(-k) where k = shared prefix length */
  padicDistance: z.number().min(0).max(1),
  /** Entropy of collapsed alternatives */
  darkMass: z.number().nonnegative(),
  /** Kuramoto order parameter (0-1) */
  resonance: z.number().min(0).max(1),
});
export type Drift = z.infer<typeof Drift>;

// Temporal echo = semantically close (<0.2) + causally distant (>5)
export function isTemporalEcho(drift: Drift): boolean {
  return drift.semanticDistance < 0.2 && drift.causalDistance > 5;
}

// ============================================================================
// PRIMITIVE 3: FABRIC
// Topology of token flow. Physical routing ≅ semantic routing.
// ============================================================================

export const FabricNode = z.object({
  id: z.string().uuid(),
  /** Compute capacity (tokens/sec) */
  capacity: z.number().positive(),
  /** Available memory (bytes) */
  memory: z.number().nonnegative(),
  /** Current temperature (exploration/exploitation) */
  temperature: z.number().nonnegative(),
  /** Current load (0-1) */
  load: z.number().min(0).max(1),
});
export type FabricNode = z.infer<typeof FabricNode>;

export const FabricEdge = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  /** Bandwidth (tokens/sec) */
  bandwidth: z.number().positive(),
  /** Latency (ms) */
  latency: z.number().nonnegative(),
});
export type FabricEdge = z.infer<typeof FabricEdge>;

export const GravityWell = z.object({
  id: z.string().uuid(),
  /** Centroid embedding in semantic space */
  centroid: z.array(z.number()).length(768),
  /** Attraction strength */
  mass: z.number().positive(),
  /** Semantic radius of influence */
  radius: z.number().positive(),
});
export type GravityWell = z.infer<typeof GravityWell>;

export const Fabric = z.object({
  nodes: z.array(FabricNode),
  edges: z.array(FabricEdge),
  gravityWells: z.array(GravityWell),
  /** Precomputed geodesics (cached optimal paths) */
  geodesics: z.map(z.string(), z.array(z.string())).optional(),
});
export type Fabric = z.infer<typeof Fabric>;

// ============================================================================
// PRIMITIVE 4: OBSERVER
// Entity that collapses potential into actuality
// ============================================================================

export const ObserverLayer = z.number().int().nonnegative();
export type ObserverLayer = z.infer<typeof ObserverLayer>;

export const Observer = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Observation frequency (Hz): Claude ≈ 4Hz, Human ≈ 1Hz */
  frequency: z.number().positive(),
  /** Abstraction layer: 0=physical, 1=computational, 2=semantic, ... */
  layer: ObserverLayer,
  /** Tokens per observation */
  collapseRate: z.number().positive(),
  /** Precursor detection threshold */
  darkSensitivity: z.number().min(0).max(1),
  /** Current phase in observation cycle */
  phase: z.number().min(0).max(2 * Math.PI),
});
export type Observer = z.infer<typeof Observer>;

// Frequency ratio = cross-layer Doppler effect
export function frequencyRatio(observer1: Observer, observer2: Observer): number {
  return observer1.frequency / observer2.frequency;
}

// ============================================================================
// PRIMITIVE 5: REALIZABILITY
// Logical structure of choice (Curry-Howard for agents)
// ============================================================================

export const AmbPoint = z.object({
  id: z.string().uuid(),
  /** Description of the choice */
  description: z.string(),
  /** Available options */
  options: z.array(z.string()),
  /** Chosen option (undefined if not yet collapsed) */
  chosen: z.string().optional(),
  /** Probability distribution over options pre-collapse */
  distribution: z.array(z.number()).optional(),
});
export type AmbPoint = z.infer<typeof AmbPoint>;

export const Realizability = z.object({
  /** Type signature / task specification */
  formula: z.string(),
  /** Program that witnesses (None until realized) */
  proof: z.string().nullable(),
  /** McCarthy choice points where agency manifests */
  ambPoints: z.array(AmbPoint),
  /** Recorded but not executed paths */
  darkBranches: z.array(z.string()),
  /** Whether the formula has been realized */
  isRealized: z.boolean(),
});
export type Realizability = z.infer<typeof Realizability>;

// ============================================================================
// COMPOSITE: AGENT ZERO STATE
// The complete state of an Agent Zero instance
// ============================================================================

export const AgentState = z.enum([
  'void',       // Uncollapsed possibility space
  'potential',  // Task specification creates possibility
  'collapse',   // Observer crystallizes terminal into reality
  'operate',    // Terminal executes task autonomously
  'trace',      // History accumulates as semantic mass
]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentZeroState = z.object({
  id: z.string().uuid(),
  name: z.string(),
  state: AgentState,
  /** Current tokens in process */
  tokens: z.array(Token),
  /** Accumulated drift from initial state */
  drift: Drift,
  /** The routing fabric this agent operates within */
  fabricNodeId: z.string().uuid(),
  /** This agent as an observer */
  observer: Observer,
  /** Current realizability state */
  realizability: Realizability,
  /** Semantic memory embeddings */
  memories: z.array(z.object({
    content: z.string(),
    embedding: z.array(z.number()).length(768),
    importance: z.number().min(0).max(1),
    timestamp: z.number(),
  })),
});
export type AgentZeroState = z.infer<typeof AgentZeroState>;

// ============================================================================
// MESSAGE PROTOCOL (AXON Extension)
// ============================================================================

export const MessageKind = z.enum([
  'spawn',      // 0x0001 - Create new agent
  'halt',       // 0x0002 - Terminate agent
  'think',      // 0x0010 - Request LLM cognition
  'percept',    // 0x0020 - Input perception
  'act',        // 0x0030 - Output action
  'invoke',     // 0x0040 - Call tool
  'resonate',   // 0x0100 - Request phase alignment
  'attune',     // 0x0101 - Adjust frequency
  'broadcast',  // 0x0102 - Send to channel
  'gradient',   // 0x0103 - Query semantic gradient
  'crystallize',// 0x0105 - Freeze pattern as attractor
]);
export type MessageKind = z.infer<typeof MessageKind>;

export const Message = z.object({
  id: z.string().uuid(),
  kind: MessageKind,
  from: z.string().uuid(),
  to: z.string().uuid().optional(), // undefined = broadcast
  payload: z.unknown(),
  timestamp: z.number(),
  /** Embedding for semantic routing */
  embedding: z.array(z.number()).length(768).optional(),
});
export type Message = z.infer<typeof Message>;
