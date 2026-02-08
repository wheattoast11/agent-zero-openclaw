import { describe, it, expect, beforeEach } from 'vitest';
import {
  McpStreamableAdapter,
  type McpRequest,
  type McpRailCallbacks,
} from '../../src/interop/mcp.js';

// ============================================================================
// MOCK CALLBACKS
// ============================================================================

function makeMockCallbacks(): McpRailCallbacks {
  return {
    searchTraces: async (embedding: number[], limit?: number) => {
      return [
        { id: 1, content: 'trace result', similarity: 0.95 },
        { id: 2, content: 'another trace', similarity: 0.80 },
      ].slice(0, limit ?? 10);
    },
    getAgents: () => [
      { id: 'agent-1', name: 'Agent One', platform: 'test' },
      { id: 'agent-2', name: 'Agent Two', platform: 'a2a' },
    ],
    getCoherence: () => ({
      coherence: 0.85,
      meanPhase: 1.23,
      agentCount: 5,
    }),
    sendMessage: (_message: unknown) => {
      // no-op in tests
    },
    getStatus: () => ({
      connectedAgents: 3,
      globalCoherence: 0.85,
      messagesProcessed: 1042,
      uptimeSeconds: 3600,
      paused: false,
    }),
  };
}

function makeRequest(method: string, params?: unknown, id: string | number = 1): McpRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('McpStreamableAdapter', () => {
  let adapter: McpStreamableAdapter;
  let callbacks: McpRailCallbacks;

  beforeEach(() => {
    callbacks = makeMockCallbacks();
    adapter = new McpStreamableAdapter(callbacks);
  });

  // --------------------------------------------------------------------------
  // INITIALIZE
  // --------------------------------------------------------------------------

  describe('handleInitialize', () => {
    it('creates session', async () => {
      const req = makeRequest('initialize');
      const result = await adapter.handleRequest(req);

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId.startsWith('mcp_')).toBe(true);
      expect(result.type).toBe('json');
    });

    it('returns capabilities', () => {
      const req = makeRequest('initialize');
      const response = adapter.handleInitialize(req);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      const result = response.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe('2025-11-05');
      expect(result.capabilities).toBeDefined();
      const caps = result.capabilities as Record<string, unknown>;
      expect(caps.tools).toBeDefined();
      expect(caps.streaming).toBe(true);
      expect(result.serverInfo).toBeDefined();
      const info = result.serverInfo as Record<string, unknown>;
      expect(info.name).toBe('resonance-rail');
    });
  });

  // --------------------------------------------------------------------------
  // TOOLS LIST
  // --------------------------------------------------------------------------

  describe('handleToolsList', () => {
    it('returns 5 tools', () => {
      const response = adapter.handleToolsList(makeRequest('tools/list'));

      expect(response.jsonrpc).toBe('2.0');
      const result = response.result as { tools: unknown[] };
      expect(result.tools.length).toBe(5);

      const names = result.tools.map((t: Record<string, unknown>) => t.name);
      expect(names).toContain('rail_search_traces');
      expect(names).toContain('rail_get_agents');
      expect(names).toContain('rail_get_coherence');
      expect(names).toContain('rail_send_message');
      expect(names).toContain('rail_get_status');
    });
  });

  // --------------------------------------------------------------------------
  // TOOL CALLS
  // --------------------------------------------------------------------------

  describe('handleToolCall', () => {
    it('executes rail_search_traces', async () => {
      const req = makeRequest('tools/call', {
        name: 'rail_search_traces',
        arguments: {
          embedding: new Array(768).fill(0.1),
          limit: 2,
        },
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });

    it('executes rail_get_agents', async () => {
      const req = makeRequest('tools/call', {
        name: 'rail_get_agents',
        arguments: {},
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.length).toBe(2);
      expect(parsed[0].name).toBe('Agent One');
    });

    it('executes rail_get_coherence', async () => {
      const req = makeRequest('tools/call', {
        name: 'rail_get_coherence',
        arguments: {},
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.coherence).toBe(0.85);
      expect(parsed.meanPhase).toBe(1.23);
      expect(parsed.agentCount).toBe(5);
    });

    it('executes rail_send_message', async () => {
      let sentMessage: unknown;
      callbacks.sendMessage = (msg) => { sentMessage = msg; };

      const req = makeRequest('tools/call', {
        name: 'rail_send_message',
        arguments: {
          content: 'Hello rail',
          kind: 'broadcast',
        },
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sent).toBe(true);
      expect(sentMessage).toEqual({ content: 'Hello rail', kind: 'broadcast', to: undefined });
    });

    it('executes rail_get_status', async () => {
      const req = makeRequest('tools/call', {
        name: 'rail_get_status',
        arguments: {},
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connectedAgents).toBe(3);
      expect(parsed.globalCoherence).toBe(0.85);
      expect(parsed.uptimeSeconds).toBe(3600);
    });

    it('returns error for unknown tool', async () => {
      const req = makeRequest('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
      expect(response.error!.message).toContain('nonexistent_tool');
    });

    it('returns error when tool name missing', async () => {
      const req = makeRequest('tools/call', {
        arguments: {},
      });

      const response = await adapter.handleToolCall(req);

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });
  });

  // --------------------------------------------------------------------------
  // SESSION MANAGEMENT
  // --------------------------------------------------------------------------

  describe('session management', () => {
    it('creates and terminates sessions', () => {
      const session = adapter.getOrCreateSession();
      expect(session.id).toBeDefined();
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.capabilities.streaming).toBe(true);

      adapter.terminateSession(session.id);

      // After termination, same ID should create a new session
      const newSession = adapter.getOrCreateSession(session.id);
      expect(newSession.id).not.toBe(session.id);
    });

    it('getOrCreateSession returns existing session', () => {
      const session1 = adapter.getOrCreateSession();
      const session2 = adapter.getOrCreateSession(session1.id);

      expect(session2.id).toBe(session1.id);
    });

    it('session ID is cryptographically secure', () => {
      const session = adapter.getOrCreateSession();

      // Format: mcp_ + 32 hex chars
      expect(session.id).toMatch(/^mcp_[0-9a-f]{32}$/);
      expect(session.id.length).toBe(4 + 32); // "mcp_" + 32 hex
    });

    it('terminateSession removes session', () => {
      const session = adapter.getOrCreateSession();
      const id = session.id;

      adapter.terminateSession(id);

      // Getting with the old ID should create a new one
      const fresh = adapter.getOrCreateSession(id);
      expect(fresh.id).not.toBe(id);
    });
  });

  // --------------------------------------------------------------------------
  // REQUEST ROUTING
  // --------------------------------------------------------------------------

  describe('handleRequest', () => {
    it('returns json type for non-streaming', async () => {
      const req = makeRequest('initialize');
      const result = await adapter.handleRequest(req);

      expect(result.type).toBe('json');
      expect(result.response).toBeDefined();
    });

    it('returns error for unknown method', async () => {
      const req = makeRequest('unknown/method');
      const result = await adapter.handleRequest(req);

      expect(result.type).toBe('json');
      expect(result.response).toBeDefined();
      expect(result.response!.error).toBeDefined();
      expect(result.response!.error!.code).toBe(-32601);
    });

    it('preserves session across multiple requests', async () => {
      const req1 = makeRequest('initialize');
      const result1 = await adapter.handleRequest(req1);

      const req2 = makeRequest('tools/list');
      const result2 = await adapter.handleRequest(req2, result1.sessionId);

      expect(result2.sessionId).toBe(result1.sessionId);
    });
  });
});
