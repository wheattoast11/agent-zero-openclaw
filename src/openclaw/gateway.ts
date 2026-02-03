/**
 * OpenClaw Gateway Bridge
 *
 * Bidirectional bridge between OpenClaw gateway and Agent Zero runtime.
 * Translates OpenClaw message format ↔ AXON message protocol.
 */

import { EventEmitter } from 'eventemitter3';
import type { OpenClawMessage, OpenClawContext } from './skill.js';
import type { Message, MessageKind } from '../primitives/types.js';
import { randomUUID } from 'crypto';

export type GatewayState = 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error';

export interface GatewayConfig {
  endpoint: string;
  reconnectDelay: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
  protocolVersion: string;
}

const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  endpoint: 'wss://gateway.openclaw.dev',
  reconnectDelay: 1000,
  maxReconnectAttempts: 10,
  heartbeatInterval: 30000,
  protocolVersion: '1.0',
};

interface GatewayEvents {
  'connected': () => void;
  'disconnected': () => void;
  'message:inbound': (message: Message) => void;
  'message:outbound': (message: OpenClawMessage) => void;
  'error': (error: Error) => void;
  'state:change': (oldState: GatewayState, newState: GatewayState) => void;
}

const KIND_TO_ROLE: Partial<Record<MessageKind, OpenClawMessage['role']>> = {
  percept: 'user',
  think: 'user',
  act: 'assistant',
  broadcast: 'assistant',
  attune: 'system',
  resonate: 'system',
  spawn: 'system',
  halt: 'system',
  invoke: 'system',
  gradient: 'system',
  crystallize: 'system',
};

const ROLE_TO_KIND: Record<OpenClawMessage['role'], MessageKind> = {
  user: 'percept',
  system: 'attune',
  assistant: 'act',
};

export class OpenClawGateway extends EventEmitter<GatewayEvents> {
  private config: GatewayConfig;
  private state: GatewayState = 'disconnected';
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempts = 0;
  private sequenceNumber = 0;

  constructor(config?: Partial<GatewayConfig>) {
    super();
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
  }

  async connect(): Promise<void> {
    this.setState('connecting');
    this.reconnectAttempts = 0;

    // Simulated connection — production would use WebSocket
    this.setState('connected');
    this.emit('connected');

    this.heartbeatTimer = setInterval(() => {
      if (this.state === 'connected') {
        this.sequenceNumber++;
      }
    }, this.config.heartbeatInterval);
  }

  async disconnect(): Promise<void> {
    this.setState('disconnecting');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.setState('disconnected');
    this.emit('disconnected');
  }

  translateInbound(openclawMsg: OpenClawMessage, context: OpenClawContext): Message {
    this.sequenceNumber++;
    return {
      id: randomUUID(),
      kind: ROLE_TO_KIND[openclawMsg.role],
      from: context.userId as `${string}-${string}-${string}-${string}-${string}`,
      to: undefined,
      payload: {
        content: openclawMsg.content,
        platform: context.platform,
        conversationId: context.conversationId,
        historyLength: context.history.length,
        sequence: this.sequenceNumber,
        ...openclawMsg.metadata,
      },
      timestamp: openclawMsg.timestamp ?? Date.now(),
    };
  }

  translateOutbound(axonMsg: Message): OpenClawMessage {
    const role = KIND_TO_ROLE[axonMsg.kind] ?? 'assistant';
    const payload = axonMsg.payload as Record<string, unknown> | undefined;
    const content = typeof payload?.content === 'string'
      ? payload.content
      : typeof payload?.response === 'string'
        ? payload.response
        : JSON.stringify(payload);

    return {
      role,
      content,
      timestamp: axonMsg.timestamp,
      metadata: {
        axonId: axonMsg.id,
        kind: axonMsg.kind,
        from: axonMsg.from,
        sequence: this.sequenceNumber,
      },
    };
  }

  send(message: Message): void {
    if (this.state !== 'connected') return;
    const outbound = this.translateOutbound(message);
    this.emit('message:outbound', outbound);
  }

  receive(openclawMsg: OpenClawMessage, context: OpenClawContext): Message {
    const inbound = this.translateInbound(openclawMsg, context);
    this.emit('message:inbound', inbound);
    return inbound;
  }

  getState(): GatewayState {
    return this.state;
  }

  private setState(newState: GatewayState): void {
    const old = this.state;
    this.state = newState;
    if (old !== newState) {
      this.emit('state:change', old, newState);
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.setState('error');
      this.emit('error', new Error('Max reconnect attempts exceeded'));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    await new Promise(resolve => setTimeout(resolve, delay));
    await this.connect();
  }
}

export function createGateway(config?: Partial<GatewayConfig>): OpenClawGateway {
  return new OpenClawGateway(config);
}
