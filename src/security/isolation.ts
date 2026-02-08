/**
 * Agent Isolation Boundaries
 *
 * Enforces security boundaries between parent and child agents.
 * Controls what capabilities a child agent inherits from its parent,
 * limits spawn depth to prevent unbounded agent trees, and optionally
 * isolates semantic memory between agents.
 *
 * Security Model:
 * - Each parent-child relationship has an explicit IsolationBoundary
 * - sharedScopes defines the maximum capabilities a child can access
 * - maxSpawnDepth prevents exponential agent proliferation
 * - memoryIsolated prevents children from reading parent memories
 */

import type { CapabilityScope } from './sandbox.js';

// ============================================================================
// ISOLATION BOUNDARY
// ============================================================================

export interface IsolationBoundary {
  /** Parent agent ID */
  parentId: string;
  /** Child agent ID */
  childId: string;
  /** Scopes the child can access from parent */
  sharedScopes: CapabilityScope[];
  /** Maximum spawn depth for this child and its descendants */
  maxSpawnDepth: number;
  /** Whether the child is memory-isolated from the parent */
  memoryIsolated: boolean;
}

// ============================================================================
// ISOLATION MANAGER
// ============================================================================

/** Default maximum spawn depth if not specified */
const DEFAULT_MAX_SPAWN_DEPTH = 3;

/** Default shared scopes for child agents */
const DEFAULT_SHARED_SCOPES: CapabilityScope[] = [
  'read', 'write', 'execute', 'memory', 'broadcast',
];

export class AgentIsolationManager {
  /** Boundaries keyed by childId for O(1) lookup */
  private boundaries: Map<string, IsolationBoundary> = new Map();

  /**
   * Create an isolation boundary between a parent and child agent.
   *
   * Config fields override defaults:
   * - sharedScopes defaults to ['read', 'write', 'execute', 'memory', 'broadcast']
   * - maxSpawnDepth defaults to 3
   * - memoryIsolated defaults to true
   */
  createBoundary(
    parentId: string,
    childId: string,
    config: Partial<IsolationBoundary> = {}
  ): IsolationBoundary {
    const boundary: IsolationBoundary = {
      parentId,
      childId,
      sharedScopes: config.sharedScopes ?? [...DEFAULT_SHARED_SCOPES],
      maxSpawnDepth: config.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH,
      memoryIsolated: config.memoryIsolated ?? true,
    };

    this.boundaries.set(childId, boundary);
    return boundary;
  }

  /**
   * Check if a child agent has access to a given scope and resource.
   *
   * Returns false if:
   * - No boundary exists for the child
   * - The requested scope is not in the child's sharedScopes
   * - The scope is 'memory' and the child is memory-isolated
   */
  checkAccess(childId: string, scope: CapabilityScope, resource: string): boolean {
    const boundary = this.boundaries.get(childId);
    if (!boundary) return false;

    // Memory isolation check
    if (scope === 'memory' && boundary.memoryIsolated) {
      return false;
    }

    // Scope check
    return boundary.sharedScopes.includes(scope);
  }

  /**
   * Get the spawn depth of an agent by walking the parent chain.
   * Root agents (no boundary) have depth 0.
   */
  getSpawnDepth(agentId: string): number {
    let depth = 0;
    let currentId: string | undefined = agentId;

    while (currentId) {
      const boundary = this.boundaries.get(currentId);
      if (!boundary) break;
      depth++;
      currentId = boundary.parentId;
    }

    return depth;
  }

  /**
   * Check if an agent can spawn children.
   *
   * An agent can spawn if its current depth is less than its maxSpawnDepth.
   * If maxDepth is provided, it overrides the boundary's maxSpawnDepth.
   * Root agents (no boundary) can always spawn.
   */
  canSpawn(agentId: string, maxDepth?: number): boolean {
    const boundary = this.boundaries.get(agentId);

    // Root agents can always spawn (they have no boundary constraining them)
    if (!boundary) return true;

    const effectiveMaxDepth = maxDepth ?? boundary.maxSpawnDepth;
    const currentDepth = this.getSpawnDepth(agentId);

    return currentDepth < effectiveMaxDepth;
  }

  /**
   * Remove the boundary for a child agent.
   */
  removeBoundary(childId: string): void {
    this.boundaries.delete(childId);
  }

  /**
   * Get the boundary for a child agent, if it exists.
   */
  getBoundary(childId: string): IsolationBoundary | undefined {
    return this.boundaries.get(childId);
  }

  /**
   * Get the maximum spawn depth for an agent from its boundary.
   * Returns DEFAULT_MAX_SPAWN_DEPTH if no boundary exists.
   */
  getMaxSpawnDepth(agentId: string): number {
    const boundary = this.boundaries.get(agentId);
    return boundary?.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
  }
}
