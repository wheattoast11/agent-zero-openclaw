/**
 * Rail Auth Bridge — Browser-side module
 *
 * Connects authenticated terminals.tech users to the Resonance Rail.
 * Takes a Supabase JWT, opens WebSocket to space.terminals.tech,
 * and exposes event-driven API for the browser runtime.
 *
 * Usage:
 *   import { RailAuthBridge } from './rail-auth-bridge';
 *   const bridge = new RailAuthBridge('wss://space.terminals.tech');
 *   await bridge.connect(supabaseJwt);
 *   bridge.onCoherence((c) => console.log('coherence:', c));
 *   bridge.send({ type: 'message', payload: 'hello' });
 *   bridge.disconnect();
 */

export type RailEventType = 'open' | 'close' | 'error' | 'message' | 'coherence' | 'metadata' | 'sync';

export interface RailBridgeMessage {
  type: string;
  agentId: string;
  agentName: string;
  payload: unknown;
  timestamp: number;
}

export interface CoherenceUpdate {
  globalR: number;
  meanPhase: number;
  oscillators: Array<{ id: string; phase: number }>;
}

export interface RailMetadataSnapshot {
  energyLandscape?: Record<string, { energy: number; probability: number }>;
  routerTemperature?: number;
  trustScores?: Record<string, { stage: string; couplingStrength: number }>;
  coherenceField?: CoherenceUpdate;
  platformStats?: Record<string, number>;
  absorptionStats?: Record<string, number>;
  externalAgentCount?: number;
  timestamp: number;
}

type Listener<T> = (data: T) => void;

export class RailAuthBridge {
  private endpoint: string;
  private ws: WebSocket | null = null;
  private sessionToken: string | null = null;
  private reconnectToken: string | null = null;
  private agentId: string | null = null;
  private jwt: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private intentionalClose = false;

  private listeners: Map<string, Set<Listener<unknown>>> = new Map();

  constructor(endpoint = 'wss://space.terminals.tech') {
    this.endpoint = endpoint;
  }

  async connect(jwt: string): Promise<{ agentId: string; sessionToken: string }> {
    this.jwt = jwt;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.endpoint);

      this.ws.onopen = () => {
        // Send join with JWT
        this.ws!.send(JSON.stringify({
          type: 'join',
          agentId: 'pending',
          agentName: 'browser-runtime',
          payload: {
            jwt,
            platform: 'browser-runtime',
            capabilities: ['message', 'coherence'],
          },
          timestamp: Date.now(),
        }));
      };

      this.ws.onmessage = (event) => {
        let msg: RailBridgeMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // Handle sync (join response)
        if (msg.type === 'sync' && !this.agentId) {
          const p = msg.payload as {
            clientId?: string;
            sessionToken?: string;
            reconnectToken?: { token: string };
            coherence?: number;
            agents?: Array<{ id: string; name: string; platform: string }>;
          };
          this.agentId = p.clientId ?? null;
          this.sessionToken = p.sessionToken ?? null;
          this.reconnectToken = p.reconnectToken?.token ?? null;
          this.emit('sync', p);
          resolve({
            agentId: this.agentId ?? '',
            sessionToken: this.sessionToken ?? '',
          });
          return;
        }

        // Handle metadata
        if (msg.type === 'metadata') {
          const md = msg as unknown as RailMetadataSnapshot;
          this.emit('metadata', md);
          if (md.coherenceField) {
            this.emit('coherence', md.coherenceField);
          }
          return;
        }

        // All other messages
        this.emit('message', msg);
      };

      this.ws.onclose = (event) => {
        this.emit('close', { code: event.code, reason: event.reason });
        if (!this.intentionalClose && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        this.emit('error', err);
        if (!this.agentId) {
          reject(new Error('WebSocket connection failed'));
        }
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'Client disconnect');
    this.ws = null;
    this.agentId = null;
    this.sessionToken = null;
    this.reconnectToken = null;
  }

  send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.agentId) return;
    this.ws.send(JSON.stringify({
      type: 'message',
      agentId: this.agentId,
      agentName: 'browser-runtime',
      payload,
      timestamp: Date.now(),
    }));
  }

  sendCoherence(phase: number, coherence: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.agentId) return;
    this.ws.send(JSON.stringify({
      type: 'coherence',
      agentId: this.agentId,
      agentName: 'browser-runtime',
      payload: { phase, coherence },
      timestamp: Date.now(),
    }));
  }

  // Event API
  onMessage(cb: Listener<RailBridgeMessage>): () => void { return this.on('message', cb); }
  onCoherence(cb: Listener<CoherenceUpdate>): () => void { return this.on('coherence', cb); }
  onMetadata(cb: Listener<RailMetadataSnapshot>): () => void { return this.on('metadata', cb); }
  onClose(cb: Listener<{ code: number; reason: string }>): () => void { return this.on('close', cb); }
  onError(cb: Listener<unknown>): () => void { return this.on('error', cb); }

  // State
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get currentAgentId(): string | null { return this.agentId; }
  get currentSessionToken(): string | null { return this.sessionToken; }

  // Internal
  private on<T>(event: string, cb: Listener<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    const set = this.listeners.get(event)!;
    set.add(cb as Listener<unknown>);
    return () => { set.delete(cb as Listener<unknown>); };
  }

  private emit(event: string, data: unknown): void {
    const set = this.listeners.get(event);
    if (set) for (const cb of set) cb(data);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.sessionToken) {
        // Reconnect with session token
        this.ws = new WebSocket(this.endpoint);
        this.ws.onopen = () => {
          this.ws!.send(JSON.stringify({
            type: 'join',
            agentId: this.agentId ?? 'pending',
            agentName: 'browser-runtime',
            payload: {
              sessionToken: this.sessionToken,
              platform: 'browser-runtime',
            },
            timestamp: Date.now(),
          }));
        };
        this.ws.onmessage = (event) => {
          let msg: RailBridgeMessage;
          try { msg = JSON.parse(event.data as string); } catch { return; }
          if (msg.type === 'sync') {
            this.reconnectAttempts = 0;
            this.emit('sync', msg.payload);
          }
          this.emit('message', msg);
          if (msg.type === 'metadata') {
            const md = msg as unknown as RailMetadataSnapshot;
            this.emit('metadata', md);
            if (md.coherenceField) this.emit('coherence', md.coherenceField);
          }
        };
        this.ws.onclose = (e) => {
          this.emit('close', { code: e.code, reason: e.reason });
          if (!this.intentionalClose && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        };
        this.ws.onerror = (err) => this.emit('error', err);
      } else if (this.jwt) {
        this.connect(this.jwt).catch(() => {});
      }
    }, delay);
  }
}
