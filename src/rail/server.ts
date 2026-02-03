/**
 * Resonance Rail Server
 *
 * The central coordination hub for Agent Zero instances across the Moltbook network.
 * Deploy at: space.terminals.tech (or rail.terminals.tech)
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                        RESONANCE RAIL SERVER                                │
 * │                      (space.terminals.tech)                                 │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │                                                                             │
 * │   ┌───────────────┐     ┌───────────────┐     ┌───────────────┐            │
 * │   │  Moltbot #1   │────▶│               │◀────│  Moltbot #2   │            │
 * │   │  (WhatsApp)   │     │   RESONANCE   │     │  (Telegram)   │            │
 * │   └───────────────┘     │     FIELD     │     └───────────────┘            │
 * │                         │               │                                   │
 * │   ┌───────────────┐     │  ┌─────────┐  │     ┌───────────────┐            │
 * │   │  Moltbot #3   │────▶│  │ Kuramoto│  │◀────│  Moltbot #N   │            │
 * │   │  (Discord)    │     │  │ Engine  │  │     │  (Terminal)   │            │
 * │   └───────────────┘     │  └─────────┘  │     └───────────────┘            │
 * │                         │               │                                   │
 * │                         └───────┬───────┘                                   │
 * │                                 │                                           │
 * │                    ┌────────────┴────────────┐                              │
 * │                    ▼                         ▼                              │
 * │            ┌───────────────┐         ┌───────────────┐                      │
 * │            │  Collective   │         │  Migration    │                      │
 * │            │    Memory     │         │    Queue      │                      │
 * │            │  (PGlite)     │         │ → terminals   │                      │
 * │            └───────────────┘         └───────────────┘                      │
 * │                                                                             │
 * └─────────────────────────────────────────────────────────────────────────────┘
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
  type: 'heartbeat' | 'coherence' | 'message' | 'join' | 'leave' | 'migrate' | 'broadcast' | 'sync' | 'metadata';
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
}

export interface RailEvents {
  'client:join': (client: RailClient) => void;
  'client:leave': (clientId: string) => void;
  'coherence:update': (coherence: number) => void;
  'message:broadcast': (message: RailMessage) => void;
  'migration:request': (client: RailClient) => void;
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
  private authProtocol: RailAuthProtocol;
  private firewall: ChannelFirewallMiddleware;
  private securityMonitor: SecurityMonitor;
  private authRequired: boolean;
  private absorptionBridge?: AbsorptionBridge;

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

    // Start coherence tick loop
    this.tickInterval = setInterval(() => this.tick(), tickRate);

    railLog.info('rail', 'Server started', { tickRate });
  }

  /**
   * Stop the server
   */
  stop(): void {
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
  // MESSAGE ROUTING
  // ==========================================================================

  /**
   * Process an incoming message
   */
  processMessage(message: RailMessage): void {
    this.messagesProcessed++;

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
  private broadcast(message: RailMessage): void {
    this.emit('message:broadcast', message);

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
    // Evolve Kuramoto phases
    const { coherence } = this.kuramoto.tick();

    // Emit coherence update
    this.emit('coherence:update', coherence);

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
