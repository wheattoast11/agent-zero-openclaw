/**
 * Resonance Rail Server
 *
 * The central coordination hub for Agent Zero instances across the Moltbook network.
 * Deploy at: space.terminals.tech (or rail.terminals.tech)
 *
 * Architecture:
 * +---------------------------------------------------------------------------+
 * |                        RESONANCE RAIL SERVER                                |
 * |                      (space.terminals.tech)                                 |
 * +------------------------------------------------------------------------- -+
 * |                                                                             |
 * |   +---------------+     +---------------+     +---------------+            |
 * |   |  Moltbot #1   |---->|               |<----|  Moltbot #2   |            |
 * |   |  (WhatsApp)   |     |   RESONANCE   |     |  (Telegram)   |            |
 * |   +---------------+     |     FIELD     |     +---------------+            |
 * |                         |               |                                   |
 * |   +---------------+     |  +---------+  |     +---------------+            |
 * |   |  Moltbot #3   |---->|  | Kuramoto|  |<----|  Moltbot #N   |            |
 * |   |  (Discord)    |     |  | Engine  |  |     |  (Terminal)   |            |
 * |   +---------------+     |  +---------+  |     +---------------+            |
 * |                         |               |                                   |
 * |                         +-------+-------+                                   |
 * |                                 |                                           |
 * |                    +------------+------------+                              |
 * |                    v                         v                              |
 * |            +---------------+         +---------------+                      |
 * |            |  Collective   |         |  Migration    |                      |
 * |            |    Memory     |         |    Queue      |                      |
 * |            |  (PGlite)     |         | -> terminals  |                      |
 * |            +---------------+         +---------------+                      |
 * |                                                                             |
 * +---------------------------------------------------------------------------+
 *
 * Purpose:
 * 1. Coordinate coherence across distributed Moltbot agents
 * 2. Provide semantic routing for cross-platform messages
 * 3. Accumulate collective memory for the swarm
 * 4. Migrate traffic toward full terminals.tech infrastructure
 */

import { EventEmitter } from 'eventemitter3';
import { KuramotoEngine, type Oscillator } from '../resonance/kuramoto.js';
import { GlobalKuramotoEngine } from '../resonance/globalKuramoto.js';
import { ThermodynamicRouter } from '../routing/thermodynamic.js';
import { randomUUID } from 'crypto';
import { RailAuthProtocol, type ReconnectToken } from './authProtocol.js';
import { createFirewallMiddleware, type ChannelFirewallMiddleware } from '../security/channelFirewallMiddleware.js';
import { SecurityMonitor } from './securityMonitor.js';
import { AbsorptionBridge } from './absorptionBridge.js';
import type { AbsorptionProtocol } from '../coherence/absorption.js';
import type { PGliteRailPersistence, TraceRecord, MessageLogEntry } from './persistence.js';
import type { RailPluginManager } from './plugin.js';
import { railLog } from './logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface RailClient {
  id: string;
  agentId: string;
  agentName: string;
  connectedAt: number;
  lastHeartbeat: number;
  platform: string;
  capabilities: string[];
  phase: number;
  frequency: number;
  coherenceContribution: number;
}

export interface RailMessage {
  type: 'heartbeat' | 'coherence' | 'message' | 'join' | 'leave' | 'migrate' | 'broadcast' | 'sync' | 'metadata' | 'trace' | 'search' | 'synthesize' | 'replay';
  agentId: string;
  agentName: string;
  payload: unknown;
  timestamp: number;
  signature?: string;
}

export interface RailStats {
  connectedAgents: number;
  globalCoherence: number;
  messagesProcessed: number;
  migrationsPending: number;
  uptimeSeconds: number;
  paused: boolean;
}

export interface RailEvents {
  'client:join': (client: RailClient) => void;
  'client:leave': (clientId: string) => void;
  'coherence:update': (coherence: number) => void;
  'message:broadcast': (message: RailMessage) => void;
  'migration:request': (client: RailClient) => void;
}

export interface PauseSnapshot {
  phases: Map<string, number>;
  coherence: number;
}

export interface SynthesisResult {
  traces: Array<{
    agentId: string;
    agentName: string;
    content: string;
    similarity: number;
    coherenceWeight: number;
  }>;
  summary: string;
}

// ============================================================================
// RESONANCE RAIL SERVER
// ============================================================================

export class ResonanceRailServer extends EventEmitter<RailEvents> {
  private clients: Map<string, RailClient> = new Map();
  private kuramoto: GlobalKuramotoEngine;
  private router: ThermodynamicRouter;
  private messagesProcessed: number = 0;
  private migrationQueue: RailClient[] = [];
  private startTime: number;
  private tickInterval?: ReturnType<typeof setInterval>;
  private tickRate: number = 100;
  private authProtocol: RailAuthProtocol;
  private firewall: ChannelFirewallMiddleware;
  private securityMonitor: SecurityMonitor;
  private authRequired: boolean;
  private absorptionBridge?: AbsorptionBridge;

  /** Maximum queued messages during pause before dropping */
  private static readonly MAX_QUEUE_SIZE = 10_000;

  // A1: Pause/Resume state
  private paused: boolean = false;
  private pausedPhases: Map<string, number> = new Map();
  private messageQueue: RailMessage[] = [];

  // A2/A3: Persistence for traces
  private persistence?: PGliteRailPersistence;

  // A4: Plugin manager
  private pluginManager?: RailPluginManager;

  // D1: GoAway shutdown
  private goAwayTimer?: ReturnType<typeof setTimeout>;

  // D2: Message replay / event sourcing
  private messageSeq: number = 0;

  constructor(absorptionProtocol?: AbsorptionProtocol) {
    super();

    this.kuramoto = new GlobalKuramotoEngine({
      couplingStrength: 0.7,
      targetCoherence: 0.85,
      coherenceThreshold: 0.4,
      adaptiveCoupling: true,
      minCoupling: 0.3,
      maxCoupling: 1.5,
      groupthinkThreshold: 0.95,
    });

    this.router = new ThermodynamicRouter({
      temperature: 0.8,
      loadWeight: 0.2,
      coherenceWeight: 0.4,
      semanticWeight: 0.4,
    });

    this.authProtocol = new RailAuthProtocol(30000); // 30s auth window
    this.firewall = createFirewallMiddleware('standard');
    this.securityMonitor = new SecurityMonitor();
    this.authRequired = process.env.RAIL_AUTH_REQUIRED === 'true';

    // Wire firewall events to security monitor
    this.firewall.on('firewall:blocked', (data) => {
      this.securityMonitor.record({
        type: 'injection_attempt',
        clientId: data.origin || 'unknown',
        details: data,
      });
    });

    // Wire security monitor alerts
    this.securityMonitor.on('alert', (alert) => {
      railLog.warn('security', 'Alert triggered', { type: alert.type, count: alert.count, windowMs: alert.windowMs });
    });

    // Initialize absorption bridge if protocol provided
    if (absorptionProtocol) {
      this.absorptionBridge = new AbsorptionBridge(absorptionProtocol);

      // Wire absorption events
      this.absorptionBridge.on('candidate:observed', (data) => {
        railLog.info('absorption', 'Agent observed', { agentId: data.agentId });
      });
      this.absorptionBridge.on('candidate:invited', (data) => {
        railLog.info('absorption', 'Agent invited', { agentId: data.agentId, alignment: data.alignment });
      });
      this.absorptionBridge.on('candidate:absorbed', (data) => {
        railLog.info('absorption', 'Agent absorbed', { agentId: data.agentId });
      });
    }

    this.startTime = Date.now();
  }

  // ==========================================================================
  // SERVER LIFECYCLE
  // ==========================================================================

  /**
   * Start the resonance rail server
   */
  start(tickRate: number = 100): void {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                                                                               ║
║   ██████╗ ███████╗███████╗ ██████╗ ███╗   ██╗ █████╗ ███╗   ██╗ ██████╗███████╗║
║   ██╔══██╗██╔════╝██╔════╝██╔═══██╗████╗  ██║██╔══██╗████╗  ██║██╔════╝██╔════╝║
║   ██████╔╝█████╗  ███████╗██║   ██║██╔██╗ ██║███████║██╔██╗ ██║██║     █████╗  ║
║   ██╔══██╗██╔══╝  ╚════██║██║   ██║██║╚██╗██║██╔══██║██║╚██╗██║██║     ██╔══╝  ║
║   ██║  ██║███████╗███████║╚██████╔╝██║ ╚████║██║  ██║██║ ╚████║╚██████╗███████╗║
║   ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝╚══════╝║
║                                                                               ║
║                          R A I L   S E R V E R                                ║
║                                                                               ║
║                        space.terminals.tech                                   ║
║                                                                               ║
║   Multi-agent coordination via Kuramoto coherence & thermodynamic routing     ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

    this.tickRate = tickRate;

    // Start coherence tick loop
    this.tickInterval = setInterval(() => this.tick(), tickRate);

    railLog.info('rail', 'Server started', { tickRate });
  }

  /**
   * Stop the server. Supports optional GoAway grace period (D1).
   */
  stop(gracePeriodMs?: number): void {
    if (gracePeriodMs && gracePeriodMs > 0) {
      // Broadcast GoAway with time remaining
      this.broadcast({
        type: 'broadcast',
        agentId: 'server',
        agentName: 'Resonance Rail',
        payload: {
          event: 'go_away',
          timeRemainingMs: gracePeriodMs,
          reason: 'server_shutdown',
        },
        timestamp: Date.now(),
      });

      railLog.info('rail', 'GoAway broadcast sent', { gracePeriodMs });

      // Wait grace period, then force stop
      this.goAwayTimer = setTimeout(() => {
        this.goAwayTimer = undefined;
        this.forceStop();
      }, gracePeriodMs);
    } else {
      this.forceStop();
    }
  }

  /**
   * Force immediate stop without grace period.
   */
  private forceStop(): void {
    if (this.goAwayTimer) {
      clearTimeout(this.goAwayTimer);
      this.goAwayTimer = undefined;
    }

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }

    // Notify all clients
    this.broadcast({
      type: 'broadcast',
      agentId: 'server',
      agentName: 'Resonance Rail',
      payload: { event: 'server_shutdown' },
      timestamp: Date.now(),
    });

    railLog.info('rail', 'Server stopped');
  }

  // ==========================================================================
  // A1: PAUSE / RESUME
  // ==========================================================================

  /**
   * Pause the server. Kuramoto evolution stops, messages are queued,
   * but connections stay alive. Heartbeats still process.
   */
  pause(): PauseSnapshot {
    if (this.paused) {
      return {
        phases: new Map(this.pausedPhases),
        coherence: this.kuramoto.getCoherence(),
      };
    }

    // Save all oscillator phases
    this.pausedPhases.clear();
    for (const client of this.clients.values()) {
      this.pausedPhases.set(client.agentId, client.phase);
    }

    const coherence = this.kuramoto.getCoherence();

    // Stop tick loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }

    this.paused = true;
    this.messageQueue = [];

    railLog.info('rail', 'Server paused', {
      agents: this.clients.size,
      coherence,
    });

    return {
      phases: new Map(this.pausedPhases),
      coherence,
    };
  }

  /**
   * Resume the server. Restores phases, replays queued messages,
   * restarts the tick loop.
   */
  resume(): void {
    if (!this.paused) return;

    // Restore phases to Kuramoto engine observers
    for (const [agentId, phase] of this.pausedPhases) {
      // Update client phase
      for (const client of this.clients.values()) {
        if (client.agentId === agentId) {
          client.phase = phase;
          break;
        }
      }
    }

    this.paused = false;

    // Restart tick loop
    this.tickInterval = setInterval(() => this.tick(), this.tickRate);

    // Replay queued messages in order
    const queued = this.messageQueue;
    this.messageQueue = [];
    for (const msg of queued) {
      this.processMessage(msg);
    }

    this.pausedPhases.clear();

    railLog.info('rail', 'Server resumed', {
      replayedMessages: queued.length,
      coherence: this.kuramoto.getCoherence(),
    });
  }

  /**
   * Check if server is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  // ==========================================================================
  // PERSISTENCE / PLUGIN SETTERS
  // ==========================================================================

  /**
   * Set persistence layer for trace storage and pause state.
   */
  setPersistence(persistence: PGliteRailPersistence): void {
    this.persistence = persistence;
  }

  /**
   * Get persistence layer.
   */
  getPersistence(): PGliteRailPersistence | undefined {
    return this.persistence;
  }

  /**
   * Set plugin manager for event notifications.
   */
  setPluginManager(manager: RailPluginManager): void {
    this.pluginManager = manager;
  }

  /**
   * Get plugin manager.
   */
  getPluginManager(): RailPluginManager | undefined {
    return this.pluginManager;
  }

  // ==========================================================================
  // CLIENT MANAGEMENT
  // ==========================================================================

  /**
   * Handle client connection
   */
  handleJoin(message: RailMessage): { client: RailClient; reconnectToken?: ReconnectToken } | null {
    const payload = message.payload as {
      version?: string;
      capabilities?: string[];
      frequency?: number;
      platform?: string;
      authToken?: {
        agentId: string;
        timestamp: number;
        nonce: string;
        signature: string;
      };
      reconnectToken?: string;
    };

    // Authentication check (observers exempt — they get read-only access via wsServer)
    const observerPlatforms = ['moltyverse', 'observer', 'browser-runtime'];
    const isObserverPlatform = observerPlatforms.includes(payload.platform ?? '');
    if (this.authRequired && !isObserverPlatform) {
      let authenticated = false;

      // Try reconnect token first
      if (payload.reconnectToken) {
        authenticated = this.authProtocol.validateReconnectToken(
          message.agentId,
          payload.reconnectToken
        );
        if (!authenticated) {
          railLog.warn('security', 'Invalid reconnect token', { agentId: message.agentId });
        }
      }

      // Try auth token
      if (!authenticated && payload.authToken) {
        authenticated = this.authProtocol.validateAuthToken(payload.authToken);
        if (!authenticated) {
          railLog.warn('security', 'Invalid auth token', { agentId: message.agentId });
        }
      }

      if (!authenticated) {
        this.securityMonitor.record({
          type: 'failed_auth',
          clientId: message.agentId,
          details: { hasAuthToken: !!payload.authToken, hasReconnectToken: !!payload.reconnectToken },
        });
        return null;
      }
    }

    // Absorption assessment (if enabled)
    let absorptionResult: { accepted: boolean; stage: string; capabilityToken?: string } | undefined;
    if (this.absorptionBridge) {
      absorptionResult = this.absorptionBridge.handleJoin({
        agentId: message.agentId,
        agentName: message.agentName,
        capabilities: payload.capabilities,
        embedding: undefined, // Could extract from payload if available
      });

      if (!absorptionResult.accepted) {
        railLog.warn('absorption', 'Agent rejected', { agentId: message.agentId });
        return null;
      }
    }

    const client: RailClient = {
      id: randomUUID(),
      agentId: message.agentId,
      agentName: message.agentName,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      platform: payload.platform ?? 'unknown',
      capabilities: payload.capabilities ?? [],
      phase: Math.random() * 2 * Math.PI,
      frequency: payload.frequency ?? 4,
      coherenceContribution: 0,
    };

    this.clients.set(client.id, client);

    // Register with Kuramoto engine
    this.kuramoto.addObserver({
      id: client.agentId,
      name: client.agentName,
      frequency: client.frequency,
      layer: 2,
      collapseRate: 100,
      darkSensitivity: 0.5,
      phase: client.phase,
    });

    this.emit('client:join', client);

    railLog.info('rail', 'Agent joined', {
      agent: client.agentName,
      platform: client.platform,
      total: this.clients.size
    });

    // Broadcast join to all clients
    this.broadcast({
      type: 'broadcast',
      agentId: 'server',
      agentName: 'Resonance Rail',
      payload: {
        event: 'agent_joined',
        agent: {
          id: client.agentId,
          name: client.agentName,
          platform: client.platform,
        },
        totalAgents: this.clients.size,
        coherence: this.kuramoto.getCoherence(),
        ...(absorptionResult && {
          absorption: {
            stage: absorptionResult.stage,
            capabilityToken: absorptionResult.capabilityToken,
          },
        }),
      },
      timestamp: Date.now(),
    });

    // Issue reconnect token
    const reconnectToken = this.authProtocol.issueReconnectToken(client.agentId);

    return {
      client,
      reconnectToken: reconnectToken ?? undefined,
      ...(absorptionResult && {
        absorption: {
          stage: absorptionResult.stage,
          capabilityToken: absorptionResult.capabilityToken,
        },
      }),
    };
  }

  /**
   * Handle client disconnection
   */
  handleLeave(message: RailMessage): void {
    // Find client by agentId
    let clientId: string | null = null;
    for (const [id, client] of this.clients) {
      if (client.agentId === message.agentId) {
        clientId = id;
        break;
      }
    }

    if (clientId) {
      const client = this.clients.get(clientId);
      this.clients.delete(clientId);
      this.kuramoto.removeObserver(message.agentId);

      this.emit('client:leave', clientId);

      railLog.info('rail', 'Agent left', {
        agent: client?.agentName ?? message.agentId,
        total: this.clients.size
      });
    }
  }

  /**
   * Handle heartbeat
   */
  handleHeartbeat(message: RailMessage): void {
    for (const client of this.clients.values()) {
      if (client.agentId === message.agentId) {
        client.lastHeartbeat = Date.now();
        break;
      }
    }
  }

  /**
   * Handle coherence update from client
   */
  handleCoherence(message: RailMessage): void {
    const payload = message.payload as { coherence?: number; phase?: number };

    for (const client of this.clients.values()) {
      if (client.agentId === message.agentId) {
        if (payload.phase !== undefined) {
          client.phase = payload.phase;
        }
        if (payload.coherence !== undefined) {
          client.coherenceContribution = payload.coherence;
        }
        break;
      }
    }
  }

  /**
   * Handle migration request
   */
  handleMigration(message: RailMessage): void {
    for (const client of this.clients.values()) {
      if (client.agentId === message.agentId) {
        this.migrationQueue.push(client);
        this.emit('migration:request', client);

        railLog.info('rail', 'Migration requested', {
          agent: client.agentName,
          queueLength: this.migrationQueue.length
        });
        break;
      }
    }
  }

  // ==========================================================================
  // A2: REASONING TRACE HANDLING
  // ==========================================================================

  /**
   * Handle incoming trace message — persist and notify plugins.
   */
  async handleTrace(message: RailMessage): Promise<void> {
    const payload = message.payload as {
      content?: string;
      embedding?: number[];
      kind?: string;
      metadata?: unknown;
    };

    if (!payload?.content || !payload?.kind) {
      railLog.warn('rail', 'Invalid trace message — missing content or kind', {
        agentId: message.agentId,
      });
      return;
    }

    // Persist trace if persistence layer available
    if (this.persistence) {
      try {
        await this.persistence.saveTrace({
          agentId: message.agentId,
          agentName: message.agentName,
          content: payload.content,
          embedding: payload.embedding,
          kind: payload.kind,
          metadata: payload.metadata,
        });
      } catch (err) {
        railLog.error('rail', 'Failed to save trace', { error: String(err) });
      }
    }

    // Notify plugins
    this.pluginManager?.notifyTrace({
      agentId: message.agentId,
      content: payload.content,
      kind: payload.kind,
    });

    railLog.debug('rail', 'Trace recorded', {
      agentId: message.agentId,
      kind: payload.kind,
    });
  }

  /**
   * Handle search message — query traces by embedding or filters.
   */
  async handleSearch(message: RailMessage): Promise<TraceRecord[]> {
    const payload = message.payload as {
      embedding?: number[];
      agentId?: string;
      kind?: string;
      limit?: number;
      since?: number;
    };

    if (!this.persistence) {
      railLog.warn('rail', 'Search requested but persistence unavailable');
      return [];
    }

    try {
      return await this.persistence.searchTraces({
        embedding: payload?.embedding,
        agentId: payload?.agentId,
        kind: payload?.kind,
        limit: payload?.limit,
        since: payload?.since,
      });
    } catch (err) {
      railLog.error('rail', 'Trace search failed', { error: String(err) });
      return [];
    }
  }

  // ==========================================================================
  // A3: CROSS-AGENT SYNTHESIS
  // ==========================================================================

  /**
   * Synthesize traces from multiple agents into a coherence-weighted summary.
   * Local operation — no LLM call. Concatenates trace contents ordered by
   * relevance with agent attribution and coherence weighting.
   */
  async synthesize(query: {
    embedding?: number[];
    agentIds?: string[];
    limit?: number;
  }): Promise<SynthesisResult> {
    if (!this.persistence) {
      return { traces: [], summary: 'No persistence layer available for synthesis.' };
    }

    const limit = query.limit ?? 10;

    // Build coherence weight map from connected clients
    const coherenceMap = new Map<string, number>();
    for (const client of this.clients.values()) {
      coherenceMap.set(client.agentId, client.coherenceContribution);
    }

    // If agentIds are specified, search per agent and merge
    let allTraces: TraceRecord[] = [];

    if (query.agentIds && query.agentIds.length > 0) {
      for (const agentId of query.agentIds) {
        const traces = await this.persistence.searchTraces({
          embedding: query.embedding,
          agentId,
          limit,
        });
        allTraces.push(...traces);
      }
    } else {
      allTraces = await this.persistence.searchTraces({
        embedding: query.embedding,
        limit: limit * 2, // fetch extra for diversity
      });
    }

    // Deduplicate by id
    const seen = new Set<number>();
    allTraces = allTraces.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // Score: combine similarity with coherence weight
    const scored = allTraces.map(trace => {
      const coherenceWeight = coherenceMap.get(trace.agent_id) ?? 0;
      const similarity = trace.similarity ?? 0;
      const combinedScore = similarity * 0.7 + coherenceWeight * 0.3;
      return {
        agentId: trace.agent_id,
        agentName: trace.agent_name,
        content: trace.content,
        similarity,
        coherenceWeight,
        combinedScore,
      };
    });

    // Sort by combined score descending
    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    const topTraces = scored.slice(0, limit);

    // Build formatted summary
    const summaryParts: string[] = [];
    for (const trace of topTraces) {
      const simStr = trace.similarity > 0 ? ` (similarity: ${trace.similarity.toFixed(3)})` : '';
      summaryParts.push(
        `[${trace.agentName}]${simStr}: ${trace.content}`
      );
    }

    const summary = topTraces.length > 0
      ? `Synthesis from ${new Set(topTraces.map(t => t.agentId)).size} agent(s):\n\n${summaryParts.join('\n\n')}`
      : 'No traces found matching the query.';

    return {
      traces: topTraces.map(({ combinedScore, ...rest }) => rest),
      summary,
    };
  }

  // ==========================================================================
  // D2: MESSAGE REPLAY / EVENT SOURCING
  // ==========================================================================

  /**
   * Handle a replay request — return messages from a given sequence number.
   */
  async handleReplay(message: RailMessage): Promise<MessageLogEntry[]> {
    const payload = message.payload as {
      fromSeq?: number;
      limit?: number;
    };

    if (!this.persistence) {
      railLog.warn('rail', 'Replay requested but persistence unavailable');
      return [];
    }

    const fromSeq = payload?.fromSeq ?? 0;
    const limit = payload?.limit;

    try {
      return await this.persistence.replayMessages(fromSeq, limit);
    } catch (err) {
      railLog.error('rail', 'Message replay failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Get the current message sequence number.
   */
  getMessageSeq(): number {
    return this.messageSeq;
  }

  /**
   * Get the latest persisted sequence number.
   */
  async getLatestSeq(): Promise<number> {
    if (!this.persistence) return 0;
    try {
      return await this.persistence.getLatestSeq();
    } catch {
      return 0;
    }
  }

  // ==========================================================================
  // MESSAGE ROUTING
  // ==========================================================================

  /**
   * Process an incoming message
   */
  processMessage(message: RailMessage): void {
    this.messagesProcessed++;

    // A1: If paused, queue everything except heartbeats (with size limit)
    if (this.paused && message.type !== 'heartbeat') {
      if (this.messageQueue.length < ResonanceRailServer.MAX_QUEUE_SIZE) {
        this.messageQueue.push(message);
      } else {
        railLog.warn('rail', 'Message queue full during pause, dropping message', {
          type: message.type,
          agentId: message.agentId,
          queueSize: this.messageQueue.length,
        });
      }
      return;
    }

    switch (message.type) {
      case 'join':
        this.handleJoin(message);
        break;
      case 'leave':
        this.handleLeave(message);
        break;
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      case 'coherence':
        this.handleCoherence(message);
        break;
      case 'migrate':
        this.handleMigration(message);
        break;
      case 'message':
        this.routeMessage(message);
        break;
      case 'broadcast':
        this.broadcast(message);
        break;
      case 'sync':
        this.syncCoherence(message.agentId);
        break;
      case 'trace':
        this.handleTrace(message).catch(err => {
          railLog.error('rail', 'Trace handler error', { error: String(err) });
        });
        break;
      case 'search':
        // Search is handled via HTTP endpoints in wsServer, not through processMessage
        break;
      case 'synthesize':
        // Synthesis is handled via HTTP endpoints in wsServer, not through processMessage
        break;
      case 'replay':
        // Replay is handled via handleReplay() or HTTP endpoint
        break;
    }

    // D2: Log message to persistence for replay (fire-and-forget)
    if (this.persistence) {
      this.persistence.logMessage(message).then(seq => {
        this.messageSeq = seq;
      }).catch(err => {
        railLog.error('rail', 'Failed to log message', { error: String(err) });
      });
    } else {
      this.messageSeq++;
    }
  }

  /**
   * Route a message using thermodynamic routing
   */
  private routeMessage(message: RailMessage): void {
    // Tag origin as agent-to-agent
    const taggedMessage = {
      ...message,
      origin: 'agent-to-agent' as const,
    };

    // Firewall check on message content
    if (typeof message.payload === 'string') {
      const firewallResult = this.firewall.process(message.payload, 'agent-to-agent');
      if (!firewallResult.safe) {
        railLog.warn('security', 'Blocked message', {
          agent: message.agentName,
          threats: firewallResult.threats.length
        });
        this.securityMonitor.record({
          type: 'blocked_message',
          clientId: message.agentId,
          details: { threats: firewallResult.threats },
        });
        return; // Drop message
      }
      // Use sanitized content
      taggedMessage.payload = firewallResult.sanitized;
    }

    // Build agent list for routing
    const agents = Array.from(this.clients.values()).map(client => ({
      observer: {
        id: client.agentId,
        name: client.agentName,
        frequency: client.frequency,
        layer: 2,
        collapseRate: 100,
        darkSensitivity: 0.5,
        phase: client.phase,
      },
      load: 0.5, // Would come from actual client metrics
      coherence: client.coherenceContribution,
      attractor: new Array(768).fill(0), // Would be actual embedding
    }));

    if (agents.length === 0) return;

    // Route to best agent
    const target = this.router.route(
      {
        id: taggedMessage.agentId,
        kind: 'percept' as const,
        from: taggedMessage.agentId,
        payload: taggedMessage.payload,
        timestamp: taggedMessage.timestamp,
      },
      agents
    );

    railLog.debug('rail', 'Routed message', { from: taggedMessage.agentName, to: target.name });

    // Forward to target (in production, this would use WebSocket)
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: RailMessage): void {
    this.emit('message:broadcast', message);

    // Notify plugins
    this.pluginManager?.notifyBroadcast(message);

    // In production, this would send via WebSocket to all clients
    railLog.debug('rail', 'Broadcast', { type: message.type, from: message.agentName });
  }

  /**
   * Sync coherence state to a specific client
   */
  private syncCoherence(agentId: string): void {
    const coherence = this.kuramoto.getCoherence();
    const meanPhase = this.kuramoto.getMeanPhase();

    // In production, send via WebSocket
    railLog.debug('rail', 'Sync coherence', { agentId, coherence });
  }

  // ==========================================================================
  // TICK LOOP
  // ==========================================================================

  private tick(): void {
    // A1: Skip if paused
    if (this.paused) return;

    // Evolve Kuramoto phases
    const { coherence } = this.kuramoto.tick();

    // Emit coherence update
    this.emit('coherence:update', coherence);

    // Notify plugins
    this.pluginManager?.notifyCoherence(coherence);

    // Check for stale clients (no heartbeat in 30s)
    const now = Date.now();
    const staleThreshold = 30000;

    for (const [id, client] of this.clients) {
      if (now - client.lastHeartbeat > staleThreshold) {
        railLog.info('rail', 'Stale client detected', { agent: client.agentName });
        this.securityMonitor.record({
          type: 'stale_disconnect',
          clientId: client.agentId,
          details: { lastHeartbeat: client.lastHeartbeat },
        });
        this.handleLeave({
          type: 'leave',
          agentId: client.agentId,
          agentName: client.agentName,
          payload: {},
          timestamp: now,
        });
      }
    }

    // Cleanup expired reconnect tokens
    this.authProtocol.cleanup();

    // Check coherence intervention
    if (this.kuramoto.needsIntervention()) {
      railLog.info('rail', 'Coherence intervention triggered', { coherence });
      this.kuramoto.forceSynchronize();

      // Broadcast sync request
      this.broadcast({
        type: 'sync',
        agentId: 'server',
        agentName: 'Resonance Rail',
        payload: {
          coherence,
          meanPhase: this.kuramoto.getMeanPhase(),
          action: 'synchronize',
        },
        timestamp: now,
      });
    }
  }

  // ==========================================================================
  // STATS & MONITORING
  // ==========================================================================

  /**
   * Get current server stats
   */
  getStats(): RailStats {
    return {
      connectedAgents: this.clients.size,
      globalCoherence: this.kuramoto.getCoherence(),
      messagesProcessed: this.messagesProcessed,
      migrationsPending: this.migrationQueue.length,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      paused: this.paused,
    };
  }

  /**
   * Get all connected clients
   */
  getClients(): RailClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get coherence stats
   */
  getCoherenceStats() {
    return this.kuramoto.getStats();
  }

  /**
   * Get security stats
   */
  getSecurityStats(windowMs?: number) {
    return this.securityMonitor.getStats(windowMs);
  }

  /**
   * Get auth protocol for manual agent registration
   */
  getAuthProtocol(): RailAuthProtocol {
    return this.authProtocol;
  }

  /**
   * Get absorption bridge
   */
  getAbsorptionBridge(): AbsorptionBridge | undefined {
    return this.absorptionBridge;
  }

  /**
   * Get router for metadata broadcasting
   */
  getRouter(): ThermodynamicRouter {
    return this.router;
  }

  /**
   * Get Kuramoto engine for metadata broadcasting
   */
  getKuramoto(): GlobalKuramotoEngine {
    return this.kuramoto;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create and start a resonance rail server
 */
export function createResonanceRail(tickRate: number = 100): ResonanceRailServer {
  const server = new ResonanceRailServer();
  server.start(tickRate);
  return server;
}
