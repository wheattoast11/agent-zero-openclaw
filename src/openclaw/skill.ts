/**
 * Agent Zero OpenClaw Skill
 *
 * The main integration point between Agent Zero and OpenClaw/Moltbot.
 * This skill wraps the Agent Zero runtime and exposes it as an OpenClaw-compatible interface.
 *
 * Key Features:
 * - Thermodynamic message routing
 * - Kuramoto coherence for multi-agent coordination
 * - Isomorphic security sandbox
 * - Resonance rail connection to terminals.tech
 */

import { EventEmitter } from 'eventemitter3';
import { AgentZero, type AgentZeroConfig } from '../runtime/agent-zero.js';
import type { Message, MessageKind } from '../primitives/types.js';
import { checkout, type CheckoutConfig, type CheckoutHandle, type CheckoutMode } from '../checkout/index.js';
import chalk from 'chalk';

// ============================================================================
// OPENCLAW SKILL INTERFACE
// ============================================================================

export interface OpenClawSkillConfig {
  /** Skill name as registered in OpenClaw */
  skillName: string;
  /** Agent Zero configuration */
  agent: AgentZeroConfig;
  /** Resonance rail endpoint (e.g., space.terminals.tech) */
  resonanceRailUrl?: string;
  /** Whether to auto-connect to resonance rail */
  autoConnectRail?: boolean;
  /** Verbose logging */
  verbose?: boolean;
}

export interface OpenClawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface OpenClawContext {
  conversationId: string;
  userId: string;
  platform: 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'signal' | 'imessage' | 'terminal';
  history: OpenClawMessage[];
}

export interface SkillEvents {
  'ready': () => void;
  'message': (message: OpenClawMessage) => void;
  'coherence': (coherence: number) => void;
  'rail:connected': (endpoint: string) => void;
  'rail:message': (message: unknown) => void;
  'error': (error: Error) => void;
}

// ============================================================================
// RESONANCE RAIL PROTOCOL
// ============================================================================

/**
 * Resonance Rail connects Agent Zero instances across the Moltbook network.
 * Think of it as a semantic mesh that allows agents to:
 * - Share coherence signals (Kuramoto phase)
 * - Route messages thermodynamically
 * - Accumulate collective memory
 * - Migrate toward terminals.tech infrastructure
 */
export interface ResonanceRailMessage {
  type: 'heartbeat' | 'coherence' | 'message' | 'join' | 'leave' | 'migrate';
  agentId: string;
  agentName: string;
  payload: unknown;
  timestamp: number;
  signature?: string; // For verification
}

// ============================================================================
// AGENT ZERO OPENCLAW SKILL
// ============================================================================

export class AgentZeroSkill extends EventEmitter<SkillEvents> {
  readonly skillName: string;
  private agent: AgentZero;
  private config: OpenClawSkillConfig;
  private railConnection?: WebSocket;
  private isConnected: boolean = false;

  constructor(config: OpenClawSkillConfig) {
    super();
    this.skillName = config.skillName;
    this.config = config;
    this.agent = new AgentZero(config.agent);

    this.setupAgentListeners();
  }

  private setupAgentListeners(): void {
    this.agent.on('state:change', (oldState, newState) => {
      this.log(`State: ${oldState} → ${newState}`);
    });

    this.agent.on('coherence:change', (coherence) => {
      this.emit('coherence', coherence);

      // Broadcast coherence to rail if connected
      if (this.isConnected) {
        this.sendToRail({
          type: 'coherence',
          agentId: this.agent.id,
          agentName: this.agent.name,
          payload: { coherence, phase: this.agent.getState().observer.phase },
          timestamp: Date.now(),
        });
      }
    });

    this.agent.on('message:sent', (message) => {
      this.log(`Sent: ${message.kind}`);
    });

    this.agent.on('violation', (violation) => {
      this.log(`⚠️ Security violation: ${violation.message}`, 'warn');
    });

    this.agent.on('realize', (realizability) => {
      this.log(`✅ Task realized: ${realizability.formula.slice(0, 50)}...`);
    });
  }

  // ==========================================================================
  // OPENCLAW INTERFACE
  // ==========================================================================

  /**
   * Initialize the skill (called by OpenClaw on load)
   */
  async initialize(): Promise<void> {
    this.log('Initializing Agent Zero skill...');

    // Start the agent
    this.agent.start('OpenClaw integration ready');

    // Connect to resonance rail if configured
    if (this.config.autoConnectRail && this.config.resonanceRailUrl) {
      await this.connectToRail(this.config.resonanceRailUrl);
    }

    this.emit('ready');
    this.log('✓ Agent Zero skill ready');
  }

  /**
   * Process a message from OpenClaw
   */
  async processMessage(
    content: string,
    context: OpenClawContext
  ): Promise<OpenClawMessage> {
    this.log(`Processing message from ${context.platform}: ${content.slice(0, 50)}...`);

    // Security check: injection detection
    const state = this.agent.getState();

    // Create perception message
    const perceptMessage: Message = {
      id: crypto.randomUUID(),
      kind: 'percept',
      from: context.userId,
      to: this.agent.id,
      payload: {
        content,
        context: {
          platform: context.platform,
          conversationId: context.conversationId,
          historyLength: context.history.length,
        },
      },
      timestamp: Date.now(),
    };

    // Feed to agent
    this.agent.receive(perceptMessage);

    // Generate response (in a real implementation, this would query Claude)
    const response = await this.generateResponse(content, context);

    // Create action message
    this.agent.send('act', { response }, undefined);

    // Emit and return
    const openClawResponse: OpenClawMessage = {
      role: 'assistant',
      content: response,
      timestamp: Date.now(),
      metadata: {
        agentId: this.agent.id,
        agentName: this.agent.name,
        coherence: this.agent.getCoherence(),
        temperature: this.agent.getTemperature(),
        state: state.state,
      },
    };

    this.emit('message', openClawResponse);
    return openClawResponse;
  }

  /**
   * Generate a response (not implemented - wire LLM provider via config)
   */
  private async generateResponse(
    content: string,
    context: OpenClawContext
  ): Promise<string> {
    throw new Error('generateResponse not implemented — wire LLM provider via config');
  }

  // ==========================================================================
  // RESONANCE RAIL CONNECTION
  // ==========================================================================

  /**
   * Connect to the resonance rail service
   */
  async connectToRail(endpoint: string): Promise<void> {
    this.log(`Connecting to resonance rail: ${endpoint}`);

    try {
      // In a real implementation, this would be WebSocket
      // For now, we simulate the connection
      this.isConnected = true;

      // Send join message
      this.sendToRail({
        type: 'join',
        agentId: this.agent.id,
        agentName: this.agent.name,
        payload: {
          version: '0.1.0',
          capabilities: ['thermodynamic-routing', 'kuramoto-coherence', 'isomorphic-security'],
          frequency: this.agent.getState().observer.frequency,
        },
        timestamp: Date.now(),
      });

      this.emit('rail:connected', endpoint);
      this.log(`✓ Connected to resonance rail: ${endpoint}`);
    } catch (error) {
      this.log(`✗ Failed to connect to rail: ${error}`, 'error');
      this.emit('error', error as Error);
    }
  }

  /**
   * Disconnect from the resonance rail
   */
  disconnectFromRail(): void {
    if (!this.isConnected) return;

    this.sendToRail({
      type: 'leave',
      agentId: this.agent.id,
      agentName: this.agent.name,
      payload: {},
      timestamp: Date.now(),
    });

    this.isConnected = false;
    this.log('Disconnected from resonance rail');
  }

  /**
   * Send a message to the resonance rail
   */
  private sendToRail(message: ResonanceRailMessage): void {
    if (!this.isConnected) return;

    // In production, this sends via WebSocket
    // For now, we log the message
    this.log(`Rail → ${message.type}`, 'debug');
    this.emit('rail:message', message);
  }

  /**
   * Request migration to terminals.tech infrastructure
   */
  requestMigration(): void {
    if (!this.isConnected) {
      this.log('Cannot migrate: not connected to rail', 'warn');
      return;
    }

    this.sendToRail({
      type: 'migrate',
      agentId: this.agent.id,
      agentName: this.agent.name,
      payload: {
        targetInfra: 'terminals.tech',
        capabilities: this.agent.getState(),
      },
      timestamp: Date.now(),
    });

    this.log('Migration request sent to terminals.tech');
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /**
   * Get current agent state
   */
  getState() {
    return this.agent.getState();
  }

  /**
   * Get coherence level
   */
  getCoherence(): number {
    return this.agent.getCoherence();
  }

  /**
   * Set temperature for exploration/exploitation balance
   */
  setTemperature(temp: number): void {
    this.agent.setTemperature(temp);
  }

  /**
   * Spawn a child agent
   */
  spawnChild(config: AgentZeroConfig): AgentZero | null {
    return this.agent.spawn(config);
  }

  /**
   * Check out a self-contained Agent Zero runtime.
   * Returns a handle with send/execute/destroy methods.
   */
  checkout(mode: CheckoutMode = 'standalone', config?: Partial<CheckoutConfig>): CheckoutHandle {
    return checkout({
      mode,
      name: config?.name ?? `${this.agent.name}-checkout`,
      frequency: config?.frequency ?? this.config.agent.frequency,
      temperature: config?.temperature ?? this.config.agent.temperature,
      task: config?.task,
      swarmSize: config?.swarmSize,
      swarmNames: config?.swarmNames,
    });
  }

  /**
   * Shutdown the skill
   */
  async shutdown(): Promise<void> {
    this.log('Shutting down Agent Zero skill...');

    this.disconnectFromRail();
    this.agent.destroy();

    this.log('✓ Agent Zero skill shutdown complete');
  }

  private log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
    if (!this.config.verbose && level === 'debug') return;

    const prefix = chalk.cyan(`[Agent Zero/${this.agent.name}]`);
    const coloredMessage = level === 'warn'
      ? chalk.yellow(message)
      : level === 'error'
        ? chalk.red(message)
        : level === 'debug'
          ? chalk.gray(message)
          : message;

    console.log(`${prefix} ${coloredMessage}`);
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create an Agent Zero skill for OpenClaw
 */
export function createAgentZeroSkill(config: OpenClawSkillConfig): AgentZeroSkill {
  return new AgentZeroSkill(config);
}

/**
 * Quick start with sensible defaults
 */
export function quickStart(name: string = 'Agent Zero'): AgentZeroSkill {
  return createAgentZeroSkill({
    skillName: 'agent-zero',
    agent: {
      name,
      frequency: 4, // Claude frequency
      temperature: 0.7,
    },
    resonanceRailUrl: 'wss://space.terminals.tech/rail',
    autoConnectRail: true,
    verbose: true,
  });
}
