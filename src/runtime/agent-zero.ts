/**
 * Agent Zero Runtime
 *
 * The main orchestration engine implementing:
 * - POTENTIAL → COLLAPSE → TRACE meta-isomorphism
 * - Thermodynamic message routing
 * - Kuramoto phase-locked coherence
 * - Isomorphic security boundaries
 *
 * Terminal = Brain + Machine + Interface
 */

import { EventEmitter } from 'eventemitter3';
import { randomUUID } from 'crypto';
import type {
  AgentZeroState,
  AgentState,
  Observer,
  Message,
  MessageKind,
  Token,
  Drift,
  Realizability,
} from '../primitives/types.js';
import { ThermodynamicRouter, type RouterConfig } from '../routing/thermodynamic.js';
import { KuramotoEngine, type KuramotoConfig } from '../resonance/kuramoto.js';
import { IsomorphicSandbox, type Capability, type CapabilityScope } from '../security/sandbox.js';
import { AgentIsolationManager } from '../security/isolation.js';
import type { SessionStore, SessionSnapshot } from './sessionStore.js';
import { ContextWindow, type ContextWindowConfig } from './contextWindow.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface AgentZeroConfig {
  /** Agent name */
  name: string;
  /** Parent agent ID (set when spawned as a child) */
  parentId?: string;
  /** Observation frequency (Hz) */
  frequency?: number;
  /** Thermodynamic router config */
  router?: Partial<RouterConfig>;
  /** Kuramoto coherence config */
  kuramoto?: Partial<KuramotoConfig>;
  /** Initial temperature */
  temperature?: number;
  /** Dark sensitivity threshold */
  darkSensitivity?: number;
  /** Tick rate (ms) */
  tickRate?: number;
  /** Session persistence store */
  sessionStore?: SessionStore;
  /** Context window management config */
  contextWindow?: Partial<ContextWindowConfig>;
}

/** Phase correction coupling strength for resonate messages */
export const RESONANCE_COUPLING = 0.3;

export const DEFAULT_AGENT_ZERO_CONFIG: Required<Omit<AgentZeroConfig, 'name' | 'parentId' | 'sessionStore' | 'contextWindow'>> = {
  frequency: 4, // Claude ≈ 4Hz
  router: {},
  kuramoto: {},
  temperature: 1.0,
  darkSensitivity: 0.5,
  tickRate: 16, // 60fps
};

// ============================================================================
// EVENTS
// ============================================================================

export interface AgentZeroEvents {
  'state:change': (oldState: AgentState, newState: AgentState) => void;
  'message:received': (message: Message) => void;
  'message:sent': (message: Message) => void;
  'token:emitted': (token: Token) => void;
  'coherence:change': (coherence: number) => void;
  'violation': (violation: any) => void;
  'realize': (realizability: Realizability) => void;
  'tick': (stats: TickStats) => void;
}

export interface TickStats {
  coherence: number;
  temperature: number;
  tokenCount: number;
  messageCount: number;
  driftMagnitude: number;
}

// ============================================================================
// AGENT ZERO CLASS
// ============================================================================

export class AgentZero extends EventEmitter<AgentZeroEvents> {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;

  private state: AgentState = 'void';
  private observer: Observer;
  private tokens: Token[] = [];
  private drift: Drift;
  private realizability: Realizability;
  private memories: Array<{
    content: string;
    embedding: number[];
    importance: number;
    timestamp: number;
  }> = [];

  private router: ThermodynamicRouter;
  private kuramoto: KuramotoEngine;
  private sandbox: IsomorphicSandbox;
  private capability: Capability;
  private isolationManager: AgentIsolationManager;
  private sessionStore?: SessionStore;
  private contextWindow?: ContextWindow;

  private inbox: Message[] = [];
  private outbox: Message[] = [];
  private children: Map<string, AgentZero> = new Map();

  private tickInterval?: ReturnType<typeof setInterval>;
  private tickRate: number;
  private lastTick: number = 0;

  constructor(config: AgentZeroConfig) {
    super();

    const fullConfig = { ...DEFAULT_AGENT_ZERO_CONFIG, ...config };

    this.id = randomUUID();
    this.name = config.name;
    this.parentId = config.parentId;
    this.tickRate = fullConfig.tickRate;

    // Initialize observer
    this.observer = {
      id: this.id,
      name: this.name,
      frequency: fullConfig.frequency,
      layer: 2, // Semantic layer
      collapseRate: 100, // tokens per observation
      darkSensitivity: fullConfig.darkSensitivity,
      phase: Math.random() * 2 * Math.PI, // Random initial phase
    };

    // Initialize drift
    this.drift = {
      semanticDistance: 0,
      causalDistance: 0,
      padicDistance: 0,
      darkMass: 0,
      resonance: 1, // Start fully coherent with self
    };

    // Initialize realizability
    this.realizability = {
      formula: '', // Task specification set later
      proof: null,
      ambPoints: [],
      darkBranches: [],
      isRealized: false,
    };

    // Initialize subsystems
    this.router = new ThermodynamicRouter(fullConfig.router);
    this.kuramoto = new KuramotoEngine(fullConfig.kuramoto);
    this.sandbox = new IsomorphicSandbox();
    this.isolationManager = new AgentIsolationManager();

    // Get a capability for this agent
    const rootToken = this.sandbox.getRootToken();
    const agentCap = this.sandbox.attenuate(rootToken, {
      scopes: ['read', 'write', 'execute', 'memory', 'spawn', 'broadcast'] as CapabilityScope[],
      resources: [{ pattern: '**', type: 'allow' }],
      reason: `Agent ${this.name} capability`,
    });

    if (!agentCap) {
      throw new Error('Failed to create agent capability');
    }
    this.capability = agentCap;

    // Session persistence
    if (config.sessionStore) {
      this.sessionStore = config.sessionStore;
    }

    // Context window management
    if (config.contextWindow) {
      this.contextWindow = new ContextWindow(config.contextWindow);
    }

    // Register self as oscillator
    this.kuramoto.addObserver(this.observer);
  }

  // ==========================================================================
  // STATE MACHINE: POTENTIAL → COLLAPSE → TRACE
  // ==========================================================================

  /**
   * Transition to POTENTIAL state (task specification)
   */
  potential(taskSpecification: string): void {
    this.transitionState('potential');
    this.realizability.formula = taskSpecification;

    // Create initial dark token
    const token: Token = {
      id: randomUUID(),
      momentum: 0,
      energy: 0,
      phase: 'dark',
      ancestry: '',
      timestamp: Date.now(),
    };
    this.tokens.push(token);
  }

  /**
   * Transition to COLLAPSE state (observer crystallizes)
   */
  collapse(): void {
    this.transitionState('collapse');

    // Transition dark tokens to emitting
    for (const token of this.tokens) {
      if (token.phase === 'dark') {
        token.phase = 'emitting';
        token.momentum = this.observer.collapseRate;
      }
    }
  }

  /**
   * Transition to OPERATE state (autonomous execution)
   */
  operate(): void {
    this.transitionState('operate');
    this.startTicking();
  }

  /**
   * Transition to TRACE state (accumulate history)
   */
  trace(): void {
    this.transitionState('trace');
    this.stopTicking();

    // Emit all remaining tokens
    for (const token of this.tokens) {
      if (token.phase === 'emitting') {
        token.phase = 'emitted';
        this.emit('token:emitted', token);
      }
    }

    // Accumulate drift as semantic mass
    this.drift.darkMass += this.drift.semanticDistance;
  }

  /**
   * Realize the task (set proof)
   */
  realize(proof: string): void {
    this.realizability.proof = proof;
    this.realizability.isRealized = true;
    this.emit('realize', this.realizability);
    this.trace();
  }

  private transitionState(newState: AgentState): void {
    const oldState = this.state;
    this.state = newState;
    this.emit('state:change', oldState, newState);
  }

  // ==========================================================================
  // MESSAGE HANDLING
  // ==========================================================================

  /**
   * Send a message
   */
  send(kind: MessageKind, payload: unknown, to?: string, embedding?: number[]): Message {
    // Security check
    const check = this.sandbox.check(this.capability.token, 'broadcast', `message:${kind}`);
    if (!check.allowed) {
      this.emit('violation', check.violation);
      throw new Error(`Security violation: ${check.violation?.message}`);
    }

    const message: Message = {
      id: randomUUID(),
      kind,
      from: this.id,
      to,
      payload,
      timestamp: Date.now(),
      embedding,
    };

    this.outbox.push(message);
    this.emit('message:sent', message);

    return message;
  }

  /**
   * Receive a message
   */
  receive(message: Message): void {
    // Security check: injection detection
    let payloadStr: string;
    try {
      payloadStr = typeof message.payload === 'string'
        ? message.payload
        : JSON.stringify(message.payload);
    } catch {
      payloadStr = String(message.payload);
    }

    const injectionCheck = this.sandbox.checkInjection(payloadStr);
    if (!injectionCheck.safe) {
      this.emit('violation', injectionCheck.violation);
      return; // Silently drop injected messages
    }

    this.inbox.push(message);
    this.emit('message:received', message);

    // Update causal distance
    this.drift.causalDistance++;
  }

  /**
   * Process next message from inbox
   */
  processNext(): Message | null {
    const message = this.inbox.shift();
    if (!message) return null;

    // Handle by kind
    switch (message.kind) {
      case 'think':
        this.handleThink(message);
        break;
      case 'percept':
        this.handlePercept(message);
        break;
      case 'act':
        this.handleAct(message);
        break;
      case 'resonate':
        this.handleResonate(message);
        break;
      case 'spawn':
        this.handleSpawn(message);
        break;
      case 'halt':
        this.handleHalt(message);
        break;
      default:
        // Unknown message kind - log but don't fail
        console.warn(`Unknown message kind: ${message.kind}`);
    }

    return message;
  }

  private handleThink(message: Message): void {
    // Transition to collapse if in potential
    if (this.state === 'potential') {
      this.collapse();
    }
  }

  private handlePercept(message: Message): void {
    // Store perception as memory
    const content = typeof message.payload === 'string'
      ? message.payload
      : JSON.stringify(message.payload);

    this.memories.push({
      content,
      embedding: message.embedding ?? new Array(768).fill(0),
      importance: 0.5,
      timestamp: Date.now(),
    });

    // Context window eviction
    if (this.contextWindow && this.contextWindow.isAtCapacity(this.memories)) {
      this.memories = this.contextWindow.evict(this.memories);
    }
  }

  private handleAct(message: Message): void {
    // Create emitting token for action
    const token: Token = {
      id: randomUUID(),
      momentum: this.observer.collapseRate,
      energy: 0.1,
      phase: 'emitting',
      ancestry: this.id,
      content: typeof message.payload === 'string'
        ? message.payload
        : JSON.stringify(message.payload),
      timestamp: Date.now(),
    };
    this.tokens.push(token);
    this.emit('token:emitted', token);
  }

  private handleResonate(message: Message): void {
    // Sync phase with sender
    const targetPhase = (message.payload as any)?.phase;
    if (typeof targetPhase === 'number' && !isNaN(targetPhase)) {
      // Nudge toward target phase
      const diff = targetPhase - this.observer.phase;
      this.observer.phase += diff * RESONANCE_COUPLING;
    }
  }

  private handleSpawn(message: Message): void {
    const config = message.payload as AgentZeroConfig;
    if (!config?.name) return;

    const child = this.spawn(config);
    if (child) {
      this.send('act', { spawned: child.id, name: child.name });
    }
  }

  private handleHalt(message: Message): void {
    // Halt all children before tracing (prevent orphan agents)
    for (const [childId, child] of this.children) {
      child.stop();
      this.kuramoto.removeObserver(childId);
    }
    this.children.clear();
    this.trace();
  }

  // ==========================================================================
  // CHILD MANAGEMENT
  // ==========================================================================

  /**
   * Spawn a child agent.
   *
   * Enforces:
   * - Sandbox capability check for 'spawn' scope
   * - maxSpawnDepth limit via isolation boundaries
   * - Creates isolation boundary with attenuated capabilities
   */
  spawn(config: AgentZeroConfig): AgentZero | null {
    // Security check
    const check = this.sandbox.check(this.capability.token, 'spawn', `agent:${config.name}`);
    if (!check.allowed) {
      this.emit('violation', check.violation);
      return null;
    }

    // Enforce spawn depth limit
    if (!this.isolationManager.canSpawn(this.id)) {
      this.emit('violation', {
        type: 'scope_denied',
        message: `Agent '${this.name}' has reached maximum spawn depth`,
        timestamp: Date.now(),
      });
      return null;
    }

    // Set parentId on child config
    const childConfig: AgentZeroConfig = { ...config, parentId: this.id };
    const child = new AgentZero(childConfig);

    // Create isolation boundary for the child
    const parentDepth = this.isolationManager.getSpawnDepth(this.id);
    const parentMaxDepth = this.isolationManager.getMaxSpawnDepth(this.id);
    this.isolationManager.createBoundary(this.id, child.id, {
      maxSpawnDepth: parentMaxDepth,
      memoryIsolated: true,
      sharedScopes: ['read', 'write', 'execute', 'memory', 'broadcast'],
    });

    // Share isolation manager with child so depth tracking works across the tree
    child.isolationManager = this.isolationManager;

    // Register child with coherence engine
    this.kuramoto.addObserver(child.observer);

    // Store reference
    this.children.set(child.id, child);

    return child;
  }

  /**
   * Halt a child agent
   */
  haltChild(childId: string): void {
    const child = this.children.get(childId);
    if (child) {
      child.trace();
      this.kuramoto.removeObserver(childId);
      this.children.delete(childId);
    }
  }

  // ==========================================================================
  // TICK LOOP
  // ==========================================================================

  private startTicking(): void {
    if (this.tickInterval) return;

    this.lastTick = Date.now();
    this.tickInterval = setInterval(() => this.tick(), this.tickRate);
  }

  private stopTicking(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }

  private tick(): void {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;

    // Evolve coherence
    const { coherence } = this.kuramoto.tick();
    this.drift.resonance = coherence;

    // Check if intervention needed
    if (this.kuramoto.needsIntervention()) {
      this.kuramoto.forceSynchronize();
    }

    // Process messages
    while (this.inbox.length > 0) {
      this.processNext();
    }

    // Update drift
    this.drift.semanticDistance = Math.min(1, this.drift.semanticDistance + 0.001 * dt);

    // Emit tick stats
    const stats: TickStats = {
      coherence,
      temperature: this.router.getTemperature(),
      tokenCount: this.tokens.length,
      messageCount: this.inbox.length + this.outbox.length,
      driftMagnitude: this.drift.semanticDistance,
    };
    this.emit('tick', stats);
    this.emit('coherence:change', coherence);
  }

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  getState(): AgentZeroState {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      tokens: this.tokens,
      drift: this.drift,
      fabricNodeId: this.id, // Self-contained
      observer: this.observer,
      realizability: this.realizability,
      memories: this.memories,
    };
  }

  getCoherence(): number {
    return this.kuramoto.getCoherence();
  }

  getTemperature(): number {
    return this.router.getTemperature();
  }

  setTemperature(temp: number): void {
    this.router.setTemperature(temp);
  }

  getChildren(): AgentZero[] {
    return Array.from(this.children.values());
  }

  getIsolationManager(): AgentIsolationManager {
    return this.isolationManager;
  }

  // ==========================================================================
  // SESSION PERSISTENCE
  // ==========================================================================

  /**
   * Save current agent state as a session snapshot.
   * Requires a sessionStore to be configured.
   */
  async saveSession(): Promise<SessionSnapshot> {
    if (!this.sessionStore) {
      throw new Error('No session store configured');
    }
    return this.sessionStore.save(this);
  }

  /**
   * Restore agent state from a session snapshot.
   * Requires a sessionStore to be configured.
   */
  async restoreSession(snapshotId: string): Promise<void> {
    if (!this.sessionStore) {
      throw new Error('No session store configured');
    }
    const snapshot = await this.sessionStore.load(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    this.sessionStore.restore(this, snapshot);
  }

  /**
   * Apply a snapshot to this agent's internal state.
   * Called by SessionStore.restore().
   */
  restoreFromSnapshot(snapshot: SessionSnapshot): void {
    this.state = snapshot.state;
    this.tokens = structuredClone(snapshot.tokens);
    this.drift = structuredClone(snapshot.drift);
    this.observer.phase = snapshot.observerPhase;
    this.observer.frequency = snapshot.observerFrequency;
    this.memories = structuredClone(snapshot.memories);
    this.realizability = structuredClone(snapshot.realizability);
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the agent
   */
  start(taskSpecification: string): void {
    this.potential(taskSpecification);
    this.collapse();
    this.operate();
  }

  /**
   * Stop the agent
   */
  stop(): void {
    this.trace();

    // Stop all children
    for (const child of this.children.values()) {
      child.stop();
    }
    this.children.clear();

    // Clean up
    this.kuramoto.reset();
    this.router.reset();
    this.sandbox.clearViolations();
  }

  /**
   * Destroy the agent
   */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}
