/**
 * @terminals-tech/agent-zero/interop
 *
 * Protocol bridges for A2A (Google) and MCP v2 (Streamable HTTP).
 */

// A2A Protocol Bridge
export {
  A2ABridge,
  a2aStatusToAxonKind,
  axonKindToA2AStatus,
  agentCardToEnrollment,
  enrollmentToAgentCard,
  a2aTaskToAxon,
  axonToA2ATask,
} from './a2a.js';

export type {
  A2AAgentCard,
  A2ATask,
  A2ATaskStatus,
} from './a2a.js';

// MCP v2 Streamable HTTP Adapter
export {
  McpStreamableAdapter,
} from './mcp.js';

export type {
  McpSession,
  McpTool,
  McpRequest,
  McpResponse,
  McpRailCallbacks,
} from './mcp.js';
