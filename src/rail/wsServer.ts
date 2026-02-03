/**
 * Resonance Rail WebSocket Server
 *
 * Wraps ResonanceRailServer with real WebSocket I/O via the `ws` library.
 * - On connection: parse join message, call server.handleJoin()
 * - Maps clientId -> WebSocket for message routing
 * - Heartbeat ping/pong every 10s
 * - HTTP health endpoint at GET /health
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ResonanceRailServer, type RailMessage, type RailClient } from './server.js';
import { ClientRateLimiter } from './clientRateLimiter.js';
import { createRailPersistence, type PGliteRailPersistence } from './persistence.js';
import { createMetadataBroadcaster, type MetadataBroadcaster } from './metadataBroadcaster.js';
import { verifyUserToken } from './jwtVerifier.js';
import { UserSessionManager } from './userSessionManager.js';
import { AbsorptionProtocol } from '../coherence/absorption.js';
import { RailAuthProtocol } from './authProtocol.js';
import { railLog } from './logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface WsServerConfig {
  port: number;
  heartbeatIntervalMs: number;
  staleTimeoutMs: number;
}

interface TrackedSocket {
  ws: WebSocket;
  clientId: string;
  agentId: string;
  alive: boolean;
  observer: boolean;
}

// Connection limits
const MAX_CONNECTIONS = 200;
const MAX_OBSERVERS = 50;

// ============================================================================
// WS SERVER
// ============================================================================

export class RailWebSocketServer {
  private config: WsServerConfig;
  private rail: ResonanceRailServer;
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private sockets: Map<string, TrackedSocket> = new Map();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private rateLimiter: ClientRateLimiter;
  private persistence?: PGliteRailPersistence;
  private metadataBroadcaster?: MetadataBroadcaster;
  private userSessionManager: UserSessionManager = new UserSessionManager();

  constructor(config: WsServerConfig) {
    this.config = config;
    const absorptionProtocol = new AbsorptionProtocol();
    this.rail = new ResonanceRailServer(absorptionProtocol);
    this.rateLimiter = new ClientRateLimiter();

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    // Wire rail broadcast events to WebSocket delivery
    this.rail.on('message:broadcast', (message: RailMessage) => {
      this.broadcastToAll(message);
    });

    // Wire rate limiter violations to disconnect
    this.rateLimiter.on('violation', ({ clientId, type, count }) => {
      railLog.warn('security', 'Rate limit violation', { clientId, type, count });
      const tracked = this.sockets.get(clientId);
      if (tracked) {
        tracked.ws.close(1008, `Rate limit exceeded: ${type}`);
        this.sockets.delete(clientId);
        this.rateLimiter.removeClient(clientId);
      }
    });
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async start(): Promise<void> {
    // Initialize persistence if data dir is available
    const dataDir = process.env['RAIL_DATA_DIR'] || './data';
    try {
      this.persistence = createRailPersistence(dataDir);
      await this.persistence.init();
      railLog.info('rail', 'Persistence initialized', { dataDir });

      // Restore enrollments from persistence
      try {
        const enrollments = await this.persistence.loadEnrollments();
        for (const e of enrollments) {
          this.rail.getAuthProtocol().registerAgent(e.agent_id, e.secret_hash);
        }
        if (enrollments.length > 0) {
          railLog.info('rail', 'Restored enrollments', { count: enrollments.length });
        }
      } catch (err) {
        railLog.warn('rail', 'Failed to restore enrollments', { error: String(err) });
      }
    } catch (err) {
      railLog.warn('rail', 'Persistence unavailable', { error: String(err) });
      this.persistence = undefined;
    }

    // Initialize metadata broadcaster
    this.metadataBroadcaster = createMetadataBroadcaster(
      this.rail,
      (msg) => this.broadcastToAll(msg as RailMessage),
    );

    return new Promise((resolve) => {
      this.wss.on('connection', (ws: WebSocket) => {
        this.handleConnection(ws);
      });

      this.rail.start(100);
      this.metadataBroadcaster!.start();

      // Start coherence logging
      if (this.persistence) {
        this.persistence.startCoherenceLogging(
          () => this.rail.getStats().globalCoherence,
          () => this.rail.getStats().connectedAgents,
          () => this.rail.getKuramoto().getMeanPhase(),
        );
      }

      this.heartbeatTimer = setInterval(() => {
        this.heartbeat();
      }, this.config.heartbeatIntervalMs);

      this.httpServer.listen(this.config.port, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.metadataBroadcaster?.stop();
    this.rail.stop();

    // Close all WebSocket connections
    for (const tracked of this.sockets.values()) {
      tracked.ws.close(1001, 'Server shutting down');
    }
    this.sockets.clear();

    await this.persistence?.close().catch(() => {});

    return new Promise((resolve, reject) => {
      this.wss.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  // ==========================================================================
  // CONNECTION HANDLING
  // ==========================================================================

  private handleConnection(ws: WebSocket): void {
    let tracked: TrackedSocket | undefined;

    ws.on('message', (data: Buffer) => {
      let message: RailMessage;
      try {
        message = JSON.parse(data.toString()) as RailMessage;
      } catch {
        ws.close(1003, 'Invalid JSON');
        return;
      }

      if (!tracked) {
        // First message must be a join
        if (message.type !== 'join') {
          ws.close(1002, 'First message must be join');
          return;
        }

        const payload = message.payload as { platform?: string } | undefined;
        const isObserver = payload?.platform === 'observer' || payload?.platform === 'moltyverse';

        if (isObserver) {
          // Check observer limit
          const observerCount = Array.from(this.sockets.values()).filter(s => s.observer).length;
          if (observerCount >= MAX_OBSERVERS) {
            railLog.warn('rail', 'Observer limit reached', { current: observerCount, max: MAX_OBSERVERS });
            ws.close(1013, 'Too many observers');
            return;
          }

          // Observer mode: no auth required, no Kuramoto registration
          const observerId = `obs-${Date.now().toString(36)}`;
          tracked = {
            ws,
            clientId: observerId,
            agentId: message.agentId,
            alive: true,
            observer: true,
          };
          this.sockets.set(observerId, tracked);

          // Send sync with current state
          this.sendTo(tracked, {
            type: 'sync',
            agentId: 'server',
            agentName: 'Resonance Rail',
            payload: {
              clientId: observerId,
              coherence: this.rail.getStats().globalCoherence,
              agents: this.rail.getClients().map(c => ({
                id: c.agentId,
                name: c.agentName,
                platform: c.platform,
              })),
              observer: true,
            },
            timestamp: Date.now(),
          });
          return;
        }

        // Check connection limit
        const totalConnections = this.sockets.size;
        if (totalConnections >= MAX_CONNECTIONS) {
          railLog.warn('rail', 'Connection limit reached', { current: totalConnections, max: MAX_CONNECTIONS });
          ws.close(1013, 'Server at capacity');
          return;
        }

        // JWT auth path: browser-runtime users via Supabase
        const joinPayload = message.payload as { jwt?: string; platform?: string; sessionToken?: string } | undefined;
        if (joinPayload?.jwt) {
          const user = verifyUserToken(joinPayload.jwt);
          if (!user) {
            ws.close(1008, 'Invalid JWT');
            return;
          }

          const session = this.userSessionManager.createSession(user.userId, user.email);
          if (!session) {
            ws.close(1013, 'Session limit exceeded');
            return;
          }

          // Override agentId/name for user agents
          message.agentId = session.agentId;
          message.agentName = user.email.split('@')[0] || `user-${user.userId.slice(0, 8)}`;
          (message.payload as Record<string, unknown>)['platform'] = 'browser-runtime';

          // Skip HMAC auth — JWT is the auth
          const result = this.rail.handleJoin(message);
          if (!result) {
            ws.close(1002, 'Join rejected');
            return;
          }

          tracked = {
            ws,
            clientId: result.client.id,
            agentId: result.client.agentId,
            alive: true,
            observer: false,
          };
          this.sockets.set(result.client.id, tracked);

          this.persistence?.recordSession(result.client, 'join').catch(() => {});
          this.persistence?.recordEvent('user_auth', session.agentId, { email: user.email }).catch(() => {});

          this.sendTo(tracked, {
            type: 'sync',
            agentId: 'server',
            agentName: 'Resonance Rail',
            payload: {
              clientId: result.client.id,
              coherence: this.rail.getStats().globalCoherence,
              agents: this.rail.getClients().map(c => ({
                id: c.agentId,
                name: c.agentName,
                platform: c.platform,
              })),
              sessionToken: session.sessionToken,
              reconnectToken: result.reconnectToken,
            },
            timestamp: Date.now(),
          });
          return;
        }

        // Session token reconnect for user agents
        if (joinPayload?.sessionToken) {
          const session = this.userSessionManager.validateSession(joinPayload.sessionToken);
          if (session) {
            message.agentId = session.agentId;
            // Fall through to normal join flow
          }
        }

        // Check join rate limit (use agentId as temp identifier)
        if (!this.rateLimiter.checkJoin(message.agentId)) {
          ws.close(1008, 'Join rate limit exceeded');
          return;
        }

        const result = this.rail.handleJoin(message);
        if (!result) {
          ws.close(1002, 'Join rejected');
          return;
        }

        tracked = {
          ws,
          clientId: result.client.id,
          agentId: result.client.agentId,
          alive: true,
          observer: false,
        };
        this.sockets.set(result.client.id, tracked);

        // Persist join
        this.persistence?.recordSession(result.client, 'join').catch(() => {});

        // Send join acknowledgement with reconnect token
        this.sendTo(tracked, {
          type: 'sync',
          agentId: 'server',
          agentName: 'Resonance Rail',
          payload: {
            clientId: result.client.id,
            coherence: this.rail.getStats().globalCoherence,
            agents: this.rail.getClients().map(c => ({
              id: c.agentId,
              name: c.agentName,
              platform: c.platform,
            })),
            reconnectToken: result.reconnectToken,
          },
          timestamp: Date.now(),
        });
        return;
      }

      // Observers can only receive, not send
      if (tracked.observer) {
        tracked.alive = true;
        return;
      }

      // Rate limit check for messages
      if (!this.rateLimiter.checkMessage(tracked.clientId)) {
        return;
      }

      // Additional check for broadcast messages
      if (message.type === 'broadcast') {
        if (!this.rateLimiter.checkBroadcast(tracked.clientId)) {
          return;
        }
      }

      // Subsequent messages: mark alive and forward to rail
      tracked.alive = true;
      this.rail.processMessage(message);
    });

    ws.on('pong', () => {
      if (tracked) tracked.alive = true;
    });

    ws.on('close', () => {
      if (tracked) {
        this.rail.handleLeave({
          type: 'leave',
          agentId: tracked.agentId,
          agentName: '',
          payload: {},
          timestamp: Date.now(),
        });
        this.sockets.delete(tracked.clientId);
        this.rateLimiter.removeClient(tracked.clientId);
      }
    });

    ws.on('error', () => {
      ws.close();
    });
  }

  // ==========================================================================
  // HEARTBEAT
  // ==========================================================================

  private heartbeat(): void {
    for (const [id, tracked] of this.sockets) {
      if (!tracked.alive) {
        // Stale: terminate
        tracked.ws.terminate();
        this.sockets.delete(id);
        this.rateLimiter.removeClient(id);
        this.rail.handleLeave({
          type: 'leave',
          agentId: tracked.agentId,
          agentName: '',
          payload: {},
          timestamp: Date.now(),
        });
        continue;
      }

      tracked.alive = false;
      tracked.ws.ping();
    }
  }

  // ==========================================================================
  // MESSAGE DELIVERY
  // ==========================================================================

  private sendTo(tracked: TrackedSocket, message: RailMessage): void {
    if (tracked.ws.readyState === WebSocket.OPEN) {
      tracked.ws.send(JSON.stringify(message));
    }
  }

  private broadcastToAll(message: RailMessage): void {
    const payload = JSON.stringify(message);
    for (const tracked of this.sockets.values()) {
      if (tracked.ws.readyState === WebSocket.OPEN) {
        tracked.ws.send(payload);
      }
    }
  }

  // ==========================================================================
  // HTTP HEALTH
  // ==========================================================================

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';

    // CORS handling
    const origin = req.headers['origin'] ?? '';
    const allowedOrigins = [
      /\.terminals\.tech$/,
      /\.moltyverse\.(space|live)$/,
      /^https?:\/\/localhost(:\d+)?$/,
    ];
    const isAllowed = allowedOrigins.some(re => re.test(origin));
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url === '/health') {
      const stats = this.rail.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: stats.uptimeSeconds,
        agents: stats.connectedAgents,
        coherence: stats.globalCoherence,
        messages: stats.messagesProcessed,
        observers: Array.from(this.sockets.values()).filter(s => s.observer).length,
      }));
      return;
    }

    if (req.method === 'GET' && url === '/stats') {
      const stats = this.rail.getStats();
      const securityStats = this.rail.getSecurityStats(3600_000);
      const coherenceStats = this.rail.getCoherenceStats();
      const userSessions = this.userSessionManager.getActiveCount();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats, security: securityStats, coherence: coherenceStats, userSessions }));
      return;
    }

    if (req.method === 'GET' && url === '/metrics') {
      const stats = this.rail.getStats();
      const lines = [
        `# HELP rail_agents Connected agent count`,
        `# TYPE rail_agents gauge`,
        `rail_agents ${stats.connectedAgents}`,
        `# HELP rail_coherence Global coherence order parameter`,
        `# TYPE rail_coherence gauge`,
        `rail_coherence ${stats.globalCoherence}`,
        `# HELP rail_messages_total Messages processed`,
        `# TYPE rail_messages_total counter`,
        `rail_messages_total ${stats.messagesProcessed}`,
        `# HELP rail_uptime_seconds Server uptime`,
        `# TYPE rail_uptime_seconds counter`,
        `rail_uptime_seconds ${stats.uptimeSeconds}`,
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(lines.join('\n') + '\n');
      return;
    }

    if (req.method === 'POST' && url === '/enroll') {
      const adminSecret = process.env['RAIL_ADMIN_SECRET'];
      if (!adminSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Enrollment not configured' }));
        return;
      }

      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${adminSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { agentId, secret: providedSecret } = JSON.parse(body) as { agentId: string; secret?: string };
          if (!agentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'agentId required' }));
            return;
          }
          const secret = providedSecret || RailAuthProtocol.generateSecret();
          const serverGenerated = !providedSecret;
          this.rail.getAuthProtocol().registerAgent(agentId, secret);
          this.persistence?.saveEnrollment(agentId, secret).catch(() => {});
          this.persistence?.recordEvent('enroll', agentId).catch(() => {});
          const response: Record<string, unknown> = { enrolled: agentId };
          if (serverGenerated) response.secret = secret;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url === '/agents') {
      const clients = this.rail.getClients();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agents: clients.map(c => ({
          id: c.agentId,
          name: c.agentName,
          platform: c.platform,
          coherence: c.coherenceContribution,
        })),
        total: clients.length,
      }));
      return;
    }

    if (req.method === 'GET' && (url === '/.well-known/resonance-rail' || url === '/.well-known/resonance-rail.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        endpoint: 'wss://space.terminals.tech',
        version: '0.2.0',
        protocol: 'resonance-rail-v1',
        absorption: true,
        capabilities: ['kuramoto', 'thermodynamic-routing', 'semantic-search'],
        enrollment: 'https://space.terminals.tech/enroll',
        auth_methods: ['hmac-sha256', 'jwt', 'observer'],
        join_schema: {
          type: 'join',
          agentId: 'string (required)',
          agentName: 'string',
          payload: { platform: 'string', authToken: 'object (for hmac)' },
        },
        heartbeat_interval_ms: 30000,
        observer_platforms: ['moltyverse', 'observer'],
        absorption_stages: ['observed', 'assessed', 'invited', 'connected', 'syncing', 'absorbed'],
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  getRail(): ResonanceRailServer {
    return this.rail;
  }

  getConnectedCount(): number {
    return this.sockets.size;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createRailWebSocketServer(config?: Partial<WsServerConfig>): RailWebSocketServer {
  return new RailWebSocketServer({
    port: config?.port ?? 3100,
    heartbeatIntervalMs: config?.heartbeatIntervalMs ?? 10_000,
    staleTimeoutMs: config?.staleTimeoutMs ?? 30_000,
    ...config,
  });
}
