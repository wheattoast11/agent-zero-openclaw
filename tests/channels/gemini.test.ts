import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID as uuid } from 'crypto';
import {
  axonToGeminiInteraction,
  geminiInteractionToAxon,
  axonToGeminiBidi,
  geminiBidiToAxon,
  axonKindToGeminiStatus,
  geminiStatusToAxonKind,
  GeminiAdapter,
  type GeminiInteraction,
  type GeminiBidiMessage,
} from '../../src/channels/gemini.js';
import type { Message, MessageKind } from '../../src/primitives/types.js';

function makeMessage(kind: MessageKind, payload: unknown = 'test content'): Message {
  return {
    id: uuid(),
    kind,
    from: uuid(),
    to: undefined,
    payload,
    timestamp: Date.now(),
    embedding: undefined,
  };
}

describe('axonToGeminiInteraction', () => {
  it('translates think message', () => {
    const msg = makeMessage('think', 'reasoning about the problem');
    const interaction = axonToGeminiInteraction(msg);

    expect(interaction.id).toBe(msg.id);
    expect(interaction.status).toBe('in_progress');
    expect('text' in interaction.input).toBe(true);
    expect((interaction.input as { text: string }).text).toBe(
      'reasoning about the problem'
    );
  });

  it('translates invoke message with tool info', () => {
    const msg = makeMessage('invoke', {
      tool: 'search',
      description: 'Search the web',
      parameters: { query: 'test' },
    });
    const interaction = axonToGeminiInteraction(msg);

    expect(interaction.status).toBe('requires_action');
    expect(interaction.tools).toBeDefined();
    expect(interaction.tools!).toHaveLength(1);
    expect(interaction.tools![0].functionDeclarations[0].name).toBe('search');
  });

  it('handles object payload with content field', () => {
    const msg = makeMessage('act', { content: 'the answer' });
    const interaction = axonToGeminiInteraction(msg);
    expect((interaction.input as { text: string }).text).toBe('the answer');
  });

  it('handles null payload', () => {
    const msg = makeMessage('think', null);
    const interaction = axonToGeminiInteraction(msg);
    expect((interaction.input as { text: string }).text).toBe('');
  });
});

describe('geminiInteractionToAxon', () => {
  it('translates completed interaction', () => {
    const interaction: GeminiInteraction = {
      id: uuid(),
      input: { text: 'result text' },
      status: 'completed',
    };
    const agentId = uuid();
    const msg = geminiInteractionToAxon(interaction, agentId);

    expect(msg.kind).toBe('act');
    expect(msg.from).toBe(agentId);
    expect(msg.payload).toBe('result text');
  });

  it('translates requires_action interaction', () => {
    const interaction: GeminiInteraction = {
      id: uuid(),
      input: { text: 'need tool call' },
      status: 'requires_action',
    };
    const msg = geminiInteractionToAxon(interaction, uuid());
    expect(msg.kind).toBe('invoke');
  });

  it('handles parts-based input', () => {
    const interaction: GeminiInteraction = {
      id: uuid(),
      input: { parts: [{ text: 'part1' }, { text: 'part2' }] },
      status: 'completed',
    };
    const msg = geminiInteractionToAxon(interaction, uuid());
    expect(msg.payload).toBe('part1\npart2');
  });

  it('handles missing status (defaults to completed)', () => {
    const interaction: GeminiInteraction = {
      id: uuid(),
      input: { text: 'default status' },
    };
    const msg = geminiInteractionToAxon(interaction, uuid());
    expect(msg.kind).toBe('act');
  });
});

describe('axonToGeminiBidi', () => {
  it('translates standard message to clientContent', () => {
    const msg = makeMessage('think', 'hello world');
    const bidi = axonToGeminiBidi(msg);

    expect(bidi.type).toBe('clientContent');
    const payload = bidi.payload as Record<string, unknown>;
    expect(payload.turnComplete).toBe(true);
    expect(Array.isArray(payload.turns)).toBe(true);
  });

  it('translates invoke message to toolResponse', () => {
    const msg = makeMessage('invoke', 'tool output');
    const bidi = axonToGeminiBidi(msg);

    expect(bidi.type).toBe('toolResponse');
    const payload = bidi.payload as Record<string, unknown>;
    expect(payload.id).toBe(msg.id);
    expect(payload.output).toBe('tool output');
  });
});

describe('geminiBidiToAxon', () => {
  it('translates serverContent', () => {
    const bidi: GeminiBidiMessage = {
      type: 'serverContent',
      payload: {
        parts: [{ text: 'response ' }, { text: 'text' }],
      },
    };
    const agentId = uuid();
    const msg = geminiBidiToAxon(bidi, agentId);

    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('act');
    expect(msg!.from).toBe(agentId);
    expect(msg!.payload).toBe('response text');
  });

  it('translates goAway to halt', () => {
    const bidi: GeminiBidiMessage = {
      type: 'goAway',
      payload: { reason: 'server shutdown' },
    };
    const msg = geminiBidiToAxon(bidi, uuid());

    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('halt');
  });

  it('translates toolCall to invoke', () => {
    const bidi: GeminiBidiMessage = {
      type: 'toolCall',
      payload: { name: 'search', args: { q: 'test' } },
    };
    const msg = geminiBidiToAxon(bidi, uuid());

    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('invoke');
  });

  it('returns null for setup messages', () => {
    expect(geminiBidiToAxon({ type: 'setup', payload: {} }, uuid())).toBeNull();
    expect(
      geminiBidiToAxon({ type: 'setupComplete', payload: {} }, uuid())
    ).toBeNull();
  });
});

describe('kind mapping roundtrips', () => {
  it('roundtrips core AXON kinds through Gemini statuses', () => {
    const cases: Array<{ axon: MessageKind; gemini: string; backToAxon: MessageKind }> = [
      { axon: 'think', gemini: 'in_progress', backToAxon: 'think' },
      { axon: 'act', gemini: 'completed', backToAxon: 'act' },
      { axon: 'halt', gemini: 'failed', backToAxon: 'halt' },
      { axon: 'invoke', gemini: 'requires_action', backToAxon: 'invoke' },
    ];

    for (const { axon, gemini, backToAxon } of cases) {
      expect(axonKindToGeminiStatus(axon)).toBe(gemini);
      expect(geminiStatusToAxonKind(gemini)).toBe(backToAxon);
    }
  });
});

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter({
      mode: 'openrouter',
      model: 'gemini-2.5-flash',
    });
  });

  it('chains interactions via previousInteractionId', () => {
    const msg1 = makeMessage('think', 'first');
    const msg2 = makeMessage('think', 'second');

    const out1 = adapter.toGemini(msg1) as GeminiInteraction;
    expect(out1.previousInteractionId).toBeUndefined();

    const out2 = adapter.toGemini(msg2) as GeminiInteraction;
    expect(out2.previousInteractionId).toBe(msg1.id);

    expect(adapter.getChain()).toHaveLength(2);
  });

  it('resets chain', () => {
    adapter.toGemini(makeMessage('think', 'a'));
    adapter.toGemini(makeMessage('think', 'b'));
    expect(adapter.getChain()).toHaveLength(2);

    adapter.resetChain();
    expect(adapter.getChain()).toHaveLength(0);

    // Next interaction should have no previousInteractionId
    const out = adapter.toGemini(makeMessage('think', 'c')) as GeminiInteraction;
    expect(out.previousInteractionId).toBeUndefined();
  });

  it('uses bidi format in direct mode', () => {
    const directAdapter = new GeminiAdapter({
      mode: 'direct',
      model: 'gemini-2.5-flash',
    });
    const msg = makeMessage('think', 'hello');
    const out = directAdapter.toGemini(msg);
    expect('type' in out).toBe(true);
    expect((out as GeminiBidiMessage).type).toBe('clientContent');
  });

  it('fromGemini handles interaction response', () => {
    const interaction: GeminiInteraction = {
      id: uuid(),
      input: { text: 'response' },
      status: 'completed',
    };
    const msg = adapter.fromGemini(interaction);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('act');
  });

  it('fromGemini handles bidi response', () => {
    const bidi: GeminiBidiMessage = {
      type: 'serverContent',
      payload: { text: 'live response' },
    };
    const msg = adapter.fromGemini(bidi);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('act');
  });

  it('fromGemini returns null for setup bidi', () => {
    const bidi: GeminiBidiMessage = { type: 'setup', payload: {} };
    const msg = adapter.fromGemini(bidi);
    expect(msg).toBeNull();
  });

  it('tracks interactions from fromGemini in chain', () => {
    const id = uuid();
    const interaction: GeminiInteraction = {
      id,
      input: { text: 'test' },
      status: 'completed',
    };
    adapter.fromGemini(interaction);
    expect(adapter.getChain()).toContain(id);
  });
});
