/**
 * A2A (Agent-to-Agent) Protocol Bridge
 *
 * Translates between Google's A2A protocol and Agent Zero's AXON message protocol.
 * Enables interop with any A2A-compliant agent without modifying core rail infrastructure.
 *
 * A2A Spec: https://github.com/google/A2A
 * AXON: Agent Zero eXtended Object Notation (see primitives/types.ts)
 */

import { randomUUID } from 'crypto';
import type { Message, MessageKind } from '../primitives/types.js';

// ============================================================================
// A2A TYPES
// ============================================================================

/** A2A Agent Card — describes an agent's capabilities and endpoint */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
  securitySchemes?: Record<string, {
    type: 'apiKey' | 'http' | 'oauth2';
    in?: 'header' | 'query';
    name?: string;
  }>;
}

/** A2A Task — unit of work in the A2A protocol */
export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts?: Array<{
    name?: string;
    parts: Array<
      | { type: 'text'; text: string }
      | { type: 'data'; data: string; mimeType: string }
    >;
  }>;
  history?: Array<{
    role: 'user' | 'agent';
    parts: Array<{ type: 'text'; text: string }>;
  }>;
  metadata?: Record<string, unknown>;
}

export type A2ATaskStatus =
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'input_required'
  | 'auth_required';

// ============================================================================
// STATUS MAPPING
// ============================================================================

const a2aStatusToAxonKindMap: Record<A2ATaskStatus, MessageKind> = {
  working: 'think',
  completed: 'crystallize',
  failed: 'halt',
  canceled: 'halt',
  rejected: 'halt',
  input_required: 'gradient',
  auth_required: 'gradient',
};

const axonKindToA2AStatusMap: Record<string, A2ATaskStatus> = {
  think: 'working',
  act: 'working',
  percept: 'working',
  spawn: 'working',
  resonate: 'working',
  attune: 'working',
  broadcast: 'working',
  crystallize: 'completed',
  halt: 'failed',
  invoke: 'input_required',
  gradient: 'input_required',
};

/**
 * Map an A2A task status to the corresponding AXON MessageKind.
 */
export function a2aStatusToAxonKind(status: A2ATaskStatus): MessageKind {
  return a2aStatusToAxonKindMap[status];
}

/**
 * Map an AXON MessageKind to the corresponding A2A task status.
 */
export function axonKindToA2AStatus(kind: MessageKind): A2ATaskStatus {
  return axonKindToA2AStatusMap[kind] ?? 'working';
}

// ============================================================================
// TRANSLATION FUNCTIONS
// ============================================================================

/**
 * Convert an A2A Agent Card to a rail enrollment record.
 */
export function agentCardToEnrollment(card: A2AAgentCard): {
  agentId: string;
  agentName: string;
  capabilities: string[];
  platform: string;
} {
  const capabilities = card.skills.map(s => s.id);
  if (card.capabilities.streaming) capabilities.push('streaming');
  if (card.capabilities.pushNotifications) capabilities.push('push_notifications');
  if (card.capabilities.stateTransitionHistory) capabilities.push('state_history');

  return {
    agentId: `a2a:${card.name.toLowerCase().replace(/\s+/g, '-')}`,
    agentName: card.name,
    capabilities,
    platform: 'a2a',
  };
}

/**
 * Convert a rail enrollment record to an A2A Agent Card.
 */
export function enrollmentToAgentCard(enrollment: {
  agentId: string;
  agentName: string;
  capabilities: string[];
}): A2AAgentCard {
  const skills = enrollment.capabilities
    .filter(c => c !== 'streaming' && c !== 'push_notifications' && c !== 'state_history')
    .map(cap => ({
      id: cap,
      name: cap,
      description: `Capability: ${cap}`,
    }));

  return {
    name: enrollment.agentName,
    description: `Agent Zero agent: ${enrollment.agentName}`,
    url: '',
    version: '1.0.0',
    capabilities: {
      streaming: enrollment.capabilities.includes('streaming'),
      pushNotifications: enrollment.capabilities.includes('push_notifications'),
      stateTransitionHistory: enrollment.capabilities.includes('state_history'),
    },
    skills,
  };
}

/**
 * Convert an A2A Task to an AXON Message.
 */
export function a2aTaskToAxon(task: A2ATask, fromAgentId: string): Message {
  const kind = a2aStatusToAxonKind(task.status);

  // Extract text content from artifacts or history
  let content: string | undefined;

  if (task.artifacts && task.artifacts.length > 0) {
    const textParts: string[] = [];
    for (const artifact of task.artifacts) {
      for (const part of artifact.parts) {
        if (part.type === 'text') {
          textParts.push(part.text);
        }
      }
    }
    if (textParts.length > 0) {
      content = textParts.join('\n');
    }
  }

  if (!content && task.history && task.history.length > 0) {
    const lastEntry = task.history[task.history.length - 1];
    const textParts = lastEntry.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text);
    if (textParts.length > 0) {
      content = textParts.join('\n');
    }
  }

  return {
    id: task.id,
    kind,
    from: fromAgentId,
    payload: {
      content: content ?? '',
      a2aTaskId: task.id,
      a2aStatus: task.status,
      metadata: task.metadata,
    },
    timestamp: Date.now(),
  };
}

/**
 * Convert an AXON Message to an A2A Task.
 */
export function axonToA2ATask(message: Message, taskId?: string): A2ATask {
  const status = axonKindToA2AStatus(message.kind);
  const payload = message.payload as Record<string, unknown> | undefined;
  const content = typeof payload?.content === 'string'
    ? payload.content
    : typeof message.payload === 'string'
      ? message.payload
      : '';

  const task: A2ATask = {
    id: taskId ?? message.id,
    status,
    metadata: {
      axonKind: message.kind,
      axonFrom: message.from,
      ...(typeof payload?.metadata === 'object' && payload.metadata !== null
        ? payload.metadata as Record<string, unknown>
        : {}),
    },
  };

  if (content) {
    task.artifacts = [
      {
        parts: [{ type: 'text', text: content }],
      },
    ];
  }

  return task;
}

// ============================================================================
// A2A BRIDGE CLASS
// ============================================================================

/**
 * Bidirectional bridge between A2A JSON-RPC protocol and AXON messages.
 * Manages task state and agent card registry.
 */
/** Maximum number of tasks to retain in memory before LRU eviction */
const MAX_TASKS = 10_000;

export class A2ABridge {
  private tasks: Map<string, A2ATask> = new Map();
  private agentCards: Map<string, A2AAgentCard> = new Map();

  /**
   * Register an external A2A agent by its Agent Card.
   * Returns the generated enrollment record for the rail.
   */
  registerAgent(card: A2AAgentCard): { agentId: string; agentName: string } {
    const enrollment = agentCardToEnrollment(card);
    this.agentCards.set(enrollment.agentId, card);
    return { agentId: enrollment.agentId, agentName: enrollment.agentName };
  }

  /**
   * Translate an incoming A2A JSON-RPC method + params to an AXON Message.
   * Supports: tasks/send, tasks/sendSubscribe, tasks/get, tasks/cancel.
   */
  fromA2A(method: string, params: unknown): Message | null {
    const p = params as Record<string, unknown> | undefined;

    switch (method) {
      case 'tasks/send':
      case 'tasks/sendSubscribe': {
        if (!p) return null;
        const taskId = (p.id as string) ?? randomUUID();
        const message = p.message as { role: string; parts: Array<{ type: string; text?: string }> } | undefined;

        if (!message) return null;

        const textParts = message.parts
          .filter(part => part.type === 'text' && part.text)
          .map(part => part.text as string);
        const content = textParts.join('\n');

        // Create or update task
        const existingTask = this.tasks.get(taskId);
        const task: A2ATask = existingTask ?? {
          id: taskId,
          status: 'working',
          history: [],
        };

        task.history = task.history ?? [];
        task.history.push({
          role: message.role as 'user' | 'agent',
          parts: message.parts.filter(
            (pt): pt is { type: 'text'; text: string } => pt.type === 'text' && typeof pt.text === 'string'
          ),
        });

        this.tasks.set(taskId, task);
        this.evictIfNeeded();

        const fromId = (p.agentId as string) ?? 'a2a:external';

        return {
          id: randomUUID(),
          kind: 'percept',
          from: fromId,
          payload: {
            content,
            a2aTaskId: taskId,
            a2aMethod: method,
          },
          timestamp: Date.now(),
        };
      }

      case 'tasks/get': {
        if (!p) return null;
        const taskId = p.id as string;
        if (!taskId) return null;

        return {
          id: randomUUID(),
          kind: 'gradient',
          from: 'a2a:external',
          payload: {
            content: '',
            a2aTaskId: taskId,
            a2aMethod: method,
          },
          timestamp: Date.now(),
        };
      }

      case 'tasks/cancel': {
        if (!p) return null;
        const taskId = p.id as string;
        if (!taskId) return null;

        const task = this.tasks.get(taskId);
        if (task) {
          task.status = 'canceled';
          this.tasks.set(taskId, task);
        }

        return {
          id: randomUUID(),
          kind: 'halt',
          from: 'a2a:external',
          payload: {
            content: '',
            a2aTaskId: taskId,
            a2aMethod: method,
          },
          timestamp: Date.now(),
        };
      }

      default:
        return null;
    }
  }

  /**
   * Translate an outgoing AXON Message to A2A JSON-RPC format.
   */
  toA2A(message: Message): { method: string; params: unknown } | null {
    const payload = message.payload as Record<string, unknown> | undefined;
    const a2aTaskId = (payload?.a2aTaskId as string) ?? message.id;
    const content = typeof payload?.content === 'string'
      ? payload.content
      : typeof message.payload === 'string'
        ? message.payload
        : '';

    const status = axonKindToA2AStatus(message.kind);

    // Update internal task state
    let task = this.tasks.get(a2aTaskId);
    if (!task) {
      task = { id: a2aTaskId, status };
      this.tasks.set(a2aTaskId, task);
      this.evictIfNeeded();
    } else {
      task.status = status;
    }

    if (content) {
      task.artifacts = [
        {
          parts: [{ type: 'text', text: content }],
        },
      ];
    }

    return {
      method: 'tasks/statusUpdate',
      params: {
        id: a2aTaskId,
        status,
        artifacts: task.artifacts,
        metadata: {
          axonKind: message.kind,
          axonFrom: message.from,
        },
      },
    };
  }

  /**
   * Evict oldest tasks when the map exceeds MAX_TASKS.
   */
  private evictIfNeeded(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    const excess = this.tasks.size - MAX_TASKS;
    const keys = this.tasks.keys();
    for (let i = 0; i < excess; i++) {
      const { value, done } = keys.next();
      if (done) break;
      this.tasks.delete(value);
    }
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Update a task's status.
   */
  updateTaskStatus(taskId: string, status: A2ATaskStatus): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
    }
  }

  /**
   * Get all registered A2A Agent Cards.
   */
  getAgentCards(): A2AAgentCard[] {
    return Array.from(this.agentCards.values());
  }
}
