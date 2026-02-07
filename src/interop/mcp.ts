/**
 * MCP v2 Streamable HTTP Adapter
 *
 * Exposes Resonance Rail functionality as MCP tools via the Streamable HTTP transport.
 * Self-contained adapter that accepts callbacks for rail operations — does not import
 * or modify any rail internals.
 *
 * MCP Spec: https://modelcontextprotocol.io/specification/2025-11-05
 */

import { randomUUID, randomBytes } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface McpSession {
  id: string;
  createdAt: number;
  lastActivity: number;
  capabilities: {
    streaming: boolean;
    elicitation: boolean;
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpRailCallbacks {
  searchTraces: (embedding: number[], limit?: number) => Promise<unknown[]>;
  getAgents: () => Array<{ id: string; name: string; platform: string }>;
  getCoherence: () => { coherence: number; meanPhase: number; agentCount: number };
  sendMessage: (message: unknown) => void;
  getStatus: () => Record<string, unknown>;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const RAIL_TOOLS: McpTool[] = [
  {
    name: 'rail_search_traces',
    description: 'Search reasoning traces stored on the Resonance Rail by embedding vector similarity. Returns matching traces ordered by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        embedding: {
          type: 'array',
          items: { type: 'number' },
          description: 'Embedding vector (768-dim) to search against stored traces.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 10,
          description: 'Maximum number of traces to return.',
        },
      },
      required: ['embedding'],
    },
  },
  {
    name: 'rail_get_agents',
    description: 'List all agents currently connected to the Resonance Rail, including their IDs, names, and platforms.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'rail_get_coherence',
    description: 'Get the current Kuramoto coherence statistics from the Resonance Rail, including global coherence level, mean phase, and agent count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'rail_send_message',
    description: 'Send a message to the Resonance Rail for broadcast or routing to connected agents.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Message content to send.',
        },
        kind: {
          type: 'string',
          enum: ['think', 'percept', 'act', 'broadcast', 'gradient'],
          default: 'broadcast',
          description: 'AXON message kind.',
        },
        to: {
          type: 'string',
          description: 'Target agent ID. Omit for broadcast.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'rail_get_status',
    description: 'Get the current health and operational status of the Resonance Rail server, including uptime, connected agents, and message throughput.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ============================================================================
// MCP ERROR CODES (JSON-RPC standard + MCP extensions)
// ============================================================================

const MCP_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ============================================================================
// MCP STREAMABLE HTTP ADAPTER
// ============================================================================

/**
 * Adapter that exposes Resonance Rail functionality as MCP tools.
 * Handles JSON-RPC request/response lifecycle, session management,
 * and tool dispatch via injected callbacks.
 */
/** Session TTL in milliseconds (1 hour) */
const SESSION_TTL = 3_600_000;

/** Session cleanup interval (5 minutes) */
const CLEANUP_INTERVAL = 300_000;

export class McpStreamableAdapter {
  private sessions: Map<string, McpSession> = new Map();
  private tools: McpTool[];
  private callbacks: McpRailCallbacks;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(callbacks: McpRailCallbacks) {
    this.tools = RAIL_TOOLS;
    this.callbacks = callbacks;
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), CLEANUP_INTERVAL);
  }

  /**
   * Remove sessions that have been inactive longer than SESSION_TTL.
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Stop the cleanup timer. Call when shutting down.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Handle an incoming MCP request.
   * Routes to the appropriate handler based on method.
   */
  handleRequest(request: McpRequest, sessionId?: string): {
    type: 'json' | 'sse';
    sessionId: string;
    response?: McpResponse;
    stream?: AsyncGenerator<McpResponse>;
  } {
    const session = this.getOrCreateSession(sessionId);

    switch (request.method) {
      case 'initialize':
        return {
          type: 'json',
          sessionId: session.id,
          response: this.handleInitialize(request),
        };

      case 'tools/list':
        return {
          type: 'json',
          sessionId: session.id,
          response: this.handleToolsList(request),
        };

      case 'tools/call':
        // Tool calls are async but we resolve them synchronously here
        // since handleRequest returns a structure. The caller should
        // await handleToolCall for actual execution.
        return {
          type: 'json',
          sessionId: session.id,
          // Response will be populated by the caller using handleToolCall
        };

      default:
        return {
          type: 'json',
          sessionId: session.id,
          response: {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: MCP_ERRORS.METHOD_NOT_FOUND,
              message: `Unknown method: ${request.method}`,
            },
          },
        };
    }
  }

  /**
   * Handle the MCP initialize handshake.
   */
  handleInitialize(request: McpRequest): McpResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-11-05',
        capabilities: {
          tools: { listChanged: false },
          streaming: true,
          elicitation: false,
        },
        serverInfo: {
          name: 'resonance-rail',
          version: '1.0.0',
        },
      },
    };
  }

  /**
   * Handle tools/list — return all available MCP tools.
   */
  handleToolsList(request?: McpRequest): McpResponse {
    return {
      jsonrpc: '2.0',
      id: request?.id ?? 0,
      result: {
        tools: this.tools,
      },
    };
  }

  /**
   * Handle tools/call — dispatch to the appropriate rail callback.
   */
  async handleToolCall(request: McpRequest): Promise<McpResponse> {
    const params = request.params as {
      name?: string;
      arguments?: Record<string, unknown>;
    } | undefined;

    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCP_ERRORS.INVALID_PARAMS,
          message: 'Missing tool name in params.name',
        },
      };
    }

    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCP_ERRORS.METHOD_NOT_FOUND,
          message: `Unknown tool: ${toolName}`,
        },
      };
    }

    try {
      const result = await this.executeTool(toolName, args);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCP_ERRORS.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Execute a tool by name with the given arguments.
   */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'rail_search_traces': {
        const embedding = args.embedding as number[];
        const limit = args.limit as number | undefined;
        if (!Array.isArray(embedding)) {
          throw new Error('embedding must be an array of numbers');
        }
        return this.callbacks.searchTraces(embedding, limit);
      }

      case 'rail_get_agents':
        return this.callbacks.getAgents();

      case 'rail_get_coherence':
        return this.callbacks.getCoherence();

      case 'rail_send_message': {
        const content = args.content as string;
        if (typeof content !== 'string') {
          throw new Error('content must be a string');
        }
        const kind = (args.kind as string) ?? 'broadcast';
        const to = args.to as string | undefined;
        this.callbacks.sendMessage({ content, kind, to });
        return { sent: true };
      }

      case 'rail_get_status':
        return this.callbacks.getStatus();

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Get or create an MCP session.
   * If sessionId is provided and matches an existing session, returns it.
   * Otherwise creates a new session.
   */
  getOrCreateSession(sessionId?: string): McpSession {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.lastActivity = Date.now();
        return existing;
      }
    }

    const session: McpSession = {
      id: this.generateSessionId(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      capabilities: {
        streaming: true,
        elicitation: false,
      },
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Terminate and remove a session.
   */
  terminateSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Generate a cryptographically secure session ID.
   * Format: mcp_{32 random hex characters}
   */
  private generateSessionId(): string {
    return `mcp_${randomBytes(16).toString('hex')}`;
  }
}
