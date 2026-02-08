import { describe, it, expect, beforeEach } from 'vitest';
import {
  agentCardToEnrollment,
  enrollmentToAgentCard,
  a2aTaskToAxon,
  axonToA2ATask,
  a2aStatusToAxonKind,
  axonKindToA2AStatus,
  A2ABridge,
  type A2AAgentCard,
  type A2ATask,
  type A2ATaskStatus,
} from '../../src/interop/a2a.js';
import type { Message, MessageKind } from '../../src/primitives/types.js';

// ============================================================================
// FIXTURES
// ============================================================================

function makeAgentCard(overrides: Partial<A2AAgentCard> = {}): A2AAgentCard {
  return {
    name: 'Test Agent',
    description: 'A test A2A agent',
    url: 'https://example.com/agent',
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills: [
      {
        id: 'research',
        name: 'Research',
        description: 'Perform research queries',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        id: 'summarize',
        name: 'Summarize',
        description: 'Summarize content',
      },
    ],
    ...overrides,
  };
}

function makeAxonMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    kind: 'crystallize',
    from: 'agent-123',
    payload: { content: 'Result text', metadata: {} },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// TRANSLATION FUNCTION TESTS
// ============================================================================

describe('agentCardToEnrollment', () => {
  it('extracts correct fields', () => {
    const card = makeAgentCard();
    const enrollment = agentCardToEnrollment(card);

    expect(enrollment.agentId).toBe('a2a:test-agent');
    expect(enrollment.agentName).toBe('Test Agent');
    expect(enrollment.platform).toBe('a2a');
    expect(enrollment.capabilities).toContain('research');
    expect(enrollment.capabilities).toContain('summarize');
    expect(enrollment.capabilities).toContain('streaming');
    expect(enrollment.capabilities).toContain('state_history');
    expect(enrollment.capabilities).not.toContain('push_notifications');
  });
});

describe('enrollmentToAgentCard', () => {
  it('creates valid card', () => {
    const enrollment = {
      agentId: 'a2a:test-agent',
      agentName: 'Test Agent',
      capabilities: ['research', 'summarize', 'streaming'],
    };

    const card = enrollmentToAgentCard(enrollment);

    expect(card.name).toBe('Test Agent');
    expect(card.description).toContain('Test Agent');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(false);
    expect(card.skills.length).toBe(2);
    expect(card.skills[0].id).toBe('research');
    expect(card.skills[1].id).toBe('summarize');
  });
});

describe('a2aTaskToAxon', () => {
  it('translates completed task', () => {
    const task: A2ATask = {
      id: 'task-1',
      status: 'completed',
      artifacts: [
        {
          parts: [{ type: 'text', text: 'Final answer' }],
        },
      ],
    };

    const msg = a2aTaskToAxon(task, 'agent-x');

    expect(msg.id).toBe('task-1');
    expect(msg.kind).toBe('crystallize');
    expect(msg.from).toBe('agent-x');
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.content).toBe('Final answer');
    expect(payload.a2aTaskId).toBe('task-1');
    expect(payload.a2aStatus).toBe('completed');
  });

  it('translates working task', () => {
    const task: A2ATask = {
      id: 'task-2',
      status: 'working',
      history: [
        {
          role: 'agent',
          parts: [{ type: 'text', text: 'Processing...' }],
        },
      ],
    };

    const msg = a2aTaskToAxon(task, 'agent-y');

    expect(msg.kind).toBe('think');
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.content).toBe('Processing...');
  });

  it('translates input_required task', () => {
    const task: A2ATask = {
      id: 'task-3',
      status: 'input_required',
      artifacts: [
        {
          parts: [{ type: 'text', text: 'Please clarify your query' }],
        },
      ],
    };

    const msg = a2aTaskToAxon(task, 'agent-z');

    expect(msg.kind).toBe('gradient');
    const payload = msg.payload as Record<string, unknown>;
    expect(payload.content).toBe('Please clarify your query');
  });
});

describe('axonToA2ATask', () => {
  it('translates crystallize message', () => {
    const msg = makeAxonMessage({ kind: 'crystallize' });
    const task = axonToA2ATask(msg);

    expect(task.id).toBe(msg.id);
    expect(task.status).toBe('completed');
    expect(task.artifacts).toBeDefined();
    expect(task.artifacts![0].parts[0]).toEqual({ type: 'text', text: 'Result text' });
    expect(task.metadata).toBeDefined();
    expect((task.metadata as Record<string, unknown>).axonKind).toBe('crystallize');
  });

  it('translates think message', () => {
    const msg = makeAxonMessage({ kind: 'think', payload: { content: 'Reasoning...' } });
    const task = axonToA2ATask(msg);

    expect(task.status).toBe('working');
    expect(task.artifacts![0].parts[0]).toEqual({ type: 'text', text: 'Reasoning...' });
  });

  it('translates halt message', () => {
    const msg = makeAxonMessage({ kind: 'halt', payload: { content: 'Error occurred' } });
    const task = axonToA2ATask(msg);

    expect(task.status).toBe('failed');
  });

  it('uses provided taskId', () => {
    const msg = makeAxonMessage();
    const task = axonToA2ATask(msg, 'custom-task-id');

    expect(task.id).toBe('custom-task-id');
  });
});

describe('status mapping roundtrips', () => {
  it('a2a -> axon -> a2a preserves terminal statuses', () => {
    const statuses: A2ATaskStatus[] = ['working', 'completed', 'failed', 'input_required'];

    for (const status of statuses) {
      const axonKind = a2aStatusToAxonKind(status);
      const roundtripped = axonKindToA2AStatus(axonKind);
      expect(roundtripped).toBe(status);
    }
  });
});

// ============================================================================
// A2A BRIDGE TESTS
// ============================================================================

describe('A2ABridge', () => {
  let bridge: A2ABridge;

  beforeEach(() => {
    bridge = new A2ABridge();
  });

  it('registers agent and returns enrollment', () => {
    const card = makeAgentCard();
    const result = bridge.registerAgent(card);

    expect(result.agentId).toBe('a2a:test-agent');
    expect(result.agentName).toBe('Test Agent');
  });

  it('fromA2A translates tasks/send', () => {
    const msg = bridge.fromA2A('tasks/send', {
      id: 'task-100',
      message: {
        role: 'user',
        parts: [{ type: 'text', text: 'Hello agent' }],
      },
    });

    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('percept');
    const payload = msg!.payload as Record<string, unknown>;
    expect(payload.content).toBe('Hello agent');
    expect(payload.a2aTaskId).toBe('task-100');
  });

  it('fromA2A returns null for unknown method', () => {
    const msg = bridge.fromA2A('unknown/method', {});
    expect(msg).toBeNull();
  });

  it('toA2A translates AXON message', () => {
    const axonMsg = makeAxonMessage({
      kind: 'crystallize',
      payload: { content: 'Done', a2aTaskId: 'task-200' },
    });

    const result = bridge.toA2A(axonMsg);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('tasks/statusUpdate');
    const params = result!.params as Record<string, unknown>;
    expect(params.id).toBe('task-200');
    expect(params.status).toBe('completed');
  });

  it('tracks task state', () => {
    // Create task via fromA2A
    bridge.fromA2A('tasks/send', {
      id: 'task-300',
      message: {
        role: 'user',
        parts: [{ type: 'text', text: 'Do something' }],
      },
    });

    const task = bridge.getTask('task-300');
    expect(task).toBeDefined();
    expect(task!.id).toBe('task-300');
    expect(task!.status).toBe('working');
    expect(task!.history).toBeDefined();
    expect(task!.history!.length).toBe(1);
  });

  it('updateTaskStatus changes status', () => {
    bridge.fromA2A('tasks/send', {
      id: 'task-400',
      message: {
        role: 'user',
        parts: [{ type: 'text', text: 'Work' }],
      },
    });

    expect(bridge.getTask('task-400')!.status).toBe('working');

    bridge.updateTaskStatus('task-400', 'completed');
    expect(bridge.getTask('task-400')!.status).toBe('completed');
  });

  it('getAgentCards lists all registered', () => {
    bridge.registerAgent(makeAgentCard({ name: 'Agent Alpha' }));
    bridge.registerAgent(makeAgentCard({ name: 'Agent Beta' }));

    const cards = bridge.getAgentCards();
    expect(cards.length).toBe(2);
    expect(cards.map(c => c.name)).toContain('Agent Alpha');
    expect(cards.map(c => c.name)).toContain('Agent Beta');
  });
});
