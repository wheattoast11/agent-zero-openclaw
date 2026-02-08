/**
 * Gemini Adapter
 *
 * Translates between AXON messages and Gemini API formats.
 * Supports both standard Interactions API and Live (bidirectional WebSocket) API.
 * Structural adapter only -- actual API calls are handled externally
 * via OpenRouter or direct Gemini API.
 */

import { randomUUID as uuid } from 'crypto';
import type { Message, MessageKind } from '../primitives/types.js';

export interface GeminiConfig {
  mode: 'openrouter' | 'direct';
  model: string;
  apiKey?: string;
}

export interface GeminiInteraction {
  id?: string;
  input: { text: string } | { parts: Array<{ text: string }> };
  previousInteractionId?: string;
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>;
  }>;
  status?: 'completed' | 'in_progress' | 'requires_action' | 'failed';
}

export interface GeminiBidiMessage {
  type:
    | 'setup'
    | 'clientContent'
    | 'realtimeInput'
    | 'toolResponse'
    | 'serverContent'
    | 'toolCall'
    | 'goAway'
    | 'setupComplete';
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

const AXON_TO_GEMINI_STATUS: Record<string, string> = {
  think: 'in_progress',
  act: 'completed',
  crystallize: 'completed',
  halt: 'failed',
  invoke: 'requires_action',
  spawn: 'in_progress',
  percept: 'in_progress',
  resonate: 'in_progress',
  attune: 'in_progress',
  broadcast: 'completed',
  gradient: 'in_progress',
};

const GEMINI_STATUS_TO_AXON: Record<string, MessageKind> = {
  completed: 'act',
  in_progress: 'think',
  requires_action: 'invoke',
  failed: 'halt',
};

export function axonKindToGeminiStatus(kind: MessageKind): string {
  return AXON_TO_GEMINI_STATUS[kind] ?? 'in_progress';
}

export function geminiStatusToAxonKind(status: string): MessageKind {
  return GEMINI_STATUS_TO_AXON[status] ?? 'think';
}

// ---------------------------------------------------------------------------
// Standalone translation functions
// ---------------------------------------------------------------------------

/**
 * Translate an AXON message to a Gemini Interaction.
 */
export function axonToGeminiInteraction(message: Message): GeminiInteraction {
  const payload = message.payload;
  let text = '';
  if (typeof payload === 'string') {
    text = payload;
  } else if (payload && typeof payload === 'object' && 'content' in (payload as Record<string, unknown>)) {
    text = String((payload as Record<string, unknown>).content);
  } else if (payload !== null && payload !== undefined) {
    text = JSON.stringify(payload);
  }

  const interaction: GeminiInteraction = {
    id: message.id,
    input: { text },
    status: axonKindToGeminiStatus(message.kind) as GeminiInteraction['status'],
  };

  // If the AXON message is an invoke (tool call), attach tool declarations from payload
  if (message.kind === 'invoke' && payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (p.tool && typeof p.tool === 'string') {
      interaction.tools = [
        {
          functionDeclarations: [
            {
              name: p.tool as string,
              description: (p.description as string) ?? '',
              parameters: p.parameters ?? {},
            },
          ],
        },
      ];
    }
  }

  return interaction;
}

/**
 * Translate a Gemini Interaction response back to an AXON message.
 */
export function geminiInteractionToAxon(
  interaction: GeminiInteraction,
  fromAgentId: string
): Message {
  const status = interaction.status ?? 'completed';
  const kind = geminiStatusToAxonKind(status);

  let payloadText = '';
  if ('text' in interaction.input) {
    payloadText = interaction.input.text;
  } else if ('parts' in interaction.input) {
    payloadText = interaction.input.parts.map(p => p.text).join('\n');
  }

  return {
    id: interaction.id ?? uuid(),
    kind,
    from: fromAgentId,
    to: undefined,
    payload: payloadText,
    timestamp: Date.now(),
    embedding: undefined,
  };
}

/**
 * Translate an AXON message to a Gemini Live (bidirectional) message.
 */
export function axonToGeminiBidi(message: Message): GeminiBidiMessage {
  const payload = message.payload;
  let text = '';
  if (typeof payload === 'string') {
    text = payload;
  } else if (payload !== null && payload !== undefined) {
    text = JSON.stringify(payload);
  }

  // Map AXON kind to bidi message type
  if (message.kind === 'invoke') {
    return {
      type: 'toolResponse',
      payload: {
        id: message.id,
        output: text,
      },
    };
  }

  return {
    type: 'clientContent',
    payload: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    },
  };
}

/**
 * Translate a Gemini Live bidirectional message to an AXON message.
 * Returns null for messages that don't map to AXON (setup, setupComplete).
 */
export function geminiBidiToAxon(
  bidi: GeminiBidiMessage,
  fromAgentId: string
): Message | null {
  switch (bidi.type) {
    case 'serverContent': {
      const p = bidi.payload as Record<string, unknown> | null;
      let text = '';
      if (p && Array.isArray(p.parts)) {
        text = (p.parts as Array<{ text?: string }>)
          .map(part => part.text ?? '')
          .join('');
      } else if (p && typeof p.text === 'string') {
        text = p.text;
      }
      return {
        id: uuid(),
        kind: 'act',
        from: fromAgentId,
        to: undefined,
        payload: text,
        timestamp: Date.now(),
        embedding: undefined,
      };
    }

    case 'toolCall': {
      const p = bidi.payload as Record<string, unknown> | null;
      return {
        id: uuid(),
        kind: 'invoke',
        from: fromAgentId,
        to: undefined,
        payload: p ?? {},
        timestamp: Date.now(),
        embedding: undefined,
      };
    }

    case 'goAway': {
      return {
        id: uuid(),
        kind: 'halt',
        from: fromAgentId,
        to: undefined,
        payload: bidi.payload ?? 'goAway',
        timestamp: Date.now(),
        embedding: undefined,
      };
    }

    case 'setup':
    case 'setupComplete':
    case 'clientContent':
    case 'realtimeInput':
    case 'toolResponse':
      // These are client-side or lifecycle messages -- no AXON equivalent
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// GeminiAdapter class
// ---------------------------------------------------------------------------

export class GeminiAdapter {
  private config: GeminiConfig;
  private interactionChain: string[] = [];

  constructor(config: GeminiConfig) {
    this.config = config;
  }

  /**
   * Translate outgoing AXON message to Gemini format.
   * Uses Interaction format for standard mode, bidi for direct/live mode.
   */
  toGemini(message: Message): GeminiInteraction | GeminiBidiMessage {
    if (this.config.mode === 'direct') {
      return axonToGeminiBidi(message);
    }

    const interaction = axonToGeminiInteraction(message);

    // Chain to previous interaction if we have history
    if (this.interactionChain.length > 0) {
      interaction.previousInteractionId =
        this.interactionChain[this.interactionChain.length - 1];
    }

    // Track this interaction in the chain
    if (interaction.id) {
      this.interactionChain.push(interaction.id);
    }

    return interaction;
  }

  /**
   * Translate incoming Gemini response to AXON message.
   */
  fromGemini(response: GeminiInteraction | GeminiBidiMessage): Message | null {
    if ('type' in response) {
      // Bidirectional message
      return geminiBidiToAxon(response, this.config.model);
    }

    // Interaction response
    const interaction = response as GeminiInteraction;

    // Track interaction chain
    if (interaction.id && !this.interactionChain.includes(interaction.id)) {
      this.interactionChain.push(interaction.id);
    }

    return geminiInteractionToAxon(interaction, this.config.model);
  }

  getChain(): string[] {
    return [...this.interactionChain];
  }

  resetChain(): void {
    this.interactionChain = [];
  }
}
