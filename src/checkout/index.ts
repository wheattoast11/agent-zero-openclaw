/**
 * Agent Zero Checkout
 *
 * Self-contained runtime instances that external bots (OpenClaw, Moltbook)
 * can "check out" to get a rail-connected Agent Zero.
 *
 * Three modes:
 * - tool:       Single function execution, returns result, cleans up
 * - standalone:  Persistent agent with rail connection and tick loop
 * - swarm:      Spawns N child agents coordinated via Kuramoto
 */

import { AgentZero, type AgentZeroConfig } from '../runtime/agent-zero.js';
import type { Message, MessageKind } from '../primitives/types.js';
import { randomUUID } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

export type CheckoutMode = 'tool' | 'standalone' | 'swarm';

export interface CheckoutConfig {
  /** Agent name */
  name?: string;
  /** Checkout mode */
  mode: CheckoutMode;
  /** Agent frequency (Hz). Default: 4 */
  frequency?: number;
  /** Initial temperature. Default: 0.7 */
  temperature?: number;
  /** For swarm mode: number of child agents. Default: 3 */
  swarmSize?: number;
  /** For swarm mode: child agent names */
  swarmNames?: string[];
  /** Task specification (required for tool mode) */
  task?: string;
}

export interface CheckoutHandle {
  /** Unique checkout ID */
  id: string;
  /** The checkout mode */
  mode: CheckoutMode;
  /** The root agent */
  agent: AgentZero;
  /** Child agents (swarm mode only) */
  children: AgentZero[];
  /** Send a message to the agent */
  send(kind: MessageKind, payload: unknown): Message;
  /** Execute a task and get result (tool mode convenience) */
  execute(task: string): Promise<ToolResult>;
  /** Get current coherence */
  coherence(): number;
  /** Get current temperature */
  temperature(): number;
  /** Set temperature */
  setTemperature(t: number): void;
  /** Destroy the checkout and all agents */
  destroy(): void;
}

export interface ToolResult {
  /** Whether the task completed */
  completed: boolean;
  /** The agent's state after execution */
  state: string;
  /** Coherence at completion */
  coherence: number;
  /** Tokens emitted during execution */
  tokensEmitted: number;
  /** Messages processed */
  messagesProcessed: number;
}

// ============================================================================
// CHECKOUT FACTORY
// ============================================================================

/**
 * Check out an Agent Zero runtime instance.
 *
 * @example Tool mode (single execution):
 * ```ts
 * const handle = checkout({ mode: 'tool', task: 'Analyze this data' });
 * const result = await handle.execute('Analyze this data');
 * handle.destroy();
 * ```
 *
 * @example Standalone mode (persistent):
 * ```ts
 * const handle = checkout({ mode: 'standalone', name: 'My Agent' });
 * handle.send('percept', { content: 'Hello' });
 * // ... later
 * handle.destroy();
 * ```
 *
 * @example Swarm mode (coordinated children):
 * ```ts
 * const handle = checkout({ mode: 'swarm', swarmSize: 5 });
 * console.log(handle.children.length); // 5
 * console.log(handle.coherence()); // Kuramoto order parameter
 * handle.destroy();
 * ```
 */
export function checkout(config: CheckoutConfig): CheckoutHandle {
  const name = config.name ?? `checkout-${randomUUID().slice(0, 8)}`;
  const agentConfig: AgentZeroConfig = {
    name,
    frequency: config.frequency ?? 4,
    temperature: config.temperature ?? 0.7,
  };

  const agent = new AgentZero(agentConfig);
  const children: AgentZero[] = [];
  const id = randomUUID();

  // Start the agent
  agent.start(config.task ?? `${config.mode} checkout`);

  // Swarm mode: spawn children
  if (config.mode === 'swarm') {
    const size = config.swarmSize ?? 3;
    for (let i = 0; i < size; i++) {
      const childName = config.swarmNames?.[i] ?? `${name}-worker-${i}`;
      const child = agent.spawn({
        name: childName,
        frequency: config.frequency ?? 4,
        temperature: (config.temperature ?? 0.7) + (Math.random() * 0.2 - 0.1),
      });
      if (child) {
        child.start(`Swarm worker ${i} for: ${config.task ?? 'general'}`);
        children.push(child);
      }
    }
  }

  let tokensEmitted = 0;
  let messagesProcessed = 0;

  agent.on('token:emitted', () => { tokensEmitted++; });
  agent.on('message:received', () => { messagesProcessed++; });

  const handle: CheckoutHandle = {
    id,
    mode: config.mode,
    agent,
    children,

    send(kind: MessageKind, payload: unknown): Message {
      return agent.send(kind, payload);
    },

    async execute(task: string): Promise<ToolResult> {
      // Feed task as perception
      agent.receive({
        id: randomUUID(),
        kind: 'percept',
        from: 'checkout',
        to: agent.id,
        payload: { content: task },
        timestamp: Date.now(),
      });

      // Process the message
      agent.processNext();

      // Let one tick cycle run for coherence
      await new Promise(resolve => setTimeout(resolve, 50));

      const state = agent.getState();
      return {
        completed: true,
        state: state.state,
        coherence: agent.getCoherence(),
        tokensEmitted,
        messagesProcessed,
      };
    },

    coherence(): number {
      return agent.getCoherence();
    },

    temperature(): number {
      return agent.getTemperature();
    },

    setTemperature(t: number): void {
      agent.setTemperature(t);
    },

    destroy(): void {
      for (const child of children) {
        child.destroy();
      }
      children.length = 0;
      agent.destroy();
    },
  };

  return handle;
}
