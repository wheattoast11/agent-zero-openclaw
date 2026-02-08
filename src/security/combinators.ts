/**
 * Capability Combinators
 *
 * Nix-inspired combinator system for composing capability profiles.
 * Combinators are pure functions that produce CapabilityExpression objects,
 * which can be materialized into sandbox capabilities via attenuate().
 *
 * Composition model:
 * - combine(): union of scopes and resources (grant both)
 * - restrict(): adds deny patterns to block specific access
 * - withTTL(): sets expiration on the expression
 * - materialize(): converts expression into a live sandbox capability
 */

import {
  IsomorphicSandbox,
  type CapabilityScope,
  type ResourcePattern,
  type Capability,
} from './sandbox.js';

// ============================================================================
// CAPABILITY EXPRESSION
// ============================================================================

export interface CapabilityExpression {
  /** Scopes granted by this expression */
  scopes: CapabilityScope[];
  /** Resource patterns (allow/deny) */
  resources: ResourcePattern[];
  /** Time-to-live in milliseconds (undefined = never expires) */
  ttl?: number;
}

// ============================================================================
// PRIMITIVE COMBINATORS
// ============================================================================

/**
 * Grant read access to the given glob patterns.
 */
export function read(...patterns: string[]): CapabilityExpression {
  return {
    scopes: ['read'],
    resources: patterns.map(p => ({ pattern: p, type: 'allow' as const })),
  };
}

/**
 * Grant write access to the given glob patterns.
 */
export function write(...patterns: string[]): CapabilityExpression {
  return {
    scopes: ['write'],
    resources: patterns.map(p => ({ pattern: p, type: 'allow' as const })),
  };
}

/**
 * Grant network access to the given domain patterns.
 */
export function network(...domains: string[]): CapabilityExpression {
  return {
    scopes: ['network'],
    resources: domains.map(d => ({ pattern: d, type: 'allow' as const })),
  };
}

/**
 * Grant execute access to the given binary patterns.
 */
export function execute(...binaries: string[]): CapabilityExpression {
  return {
    scopes: ['execute'],
    resources: binaries.map(b => ({ pattern: b, type: 'allow' as const })),
  };
}

/**
 * Grant memory access with a byte limit.
 * The limit is encoded as a resource pattern: `memory:bytes:<limit>`.
 */
export function memory(limitBytes: number): CapabilityExpression {
  return {
    scopes: ['memory'],
    resources: [{ pattern: `memory:bytes:${limitBytes}`, type: 'allow' }],
  };
}

/**
 * Grant spawn access with a max children limit.
 * The limit is encoded as a resource pattern: `spawn:*:<max>`.
 */
export function spawn(maxChildren: number): CapabilityExpression {
  return {
    scopes: ['spawn'],
    resources: [{ pattern: `spawn:*:${maxChildren}`, type: 'allow' }],
  };
}

// ============================================================================
// COMPOSITION OPERATORS
// ============================================================================

/**
 * Combine multiple expressions by merging their scopes (deduped) and resources.
 * If any expression has a TTL, the minimum TTL is used.
 */
export function combine(...exprs: CapabilityExpression[]): CapabilityExpression {
  const scopeSet = new Set<CapabilityScope>();
  const resources: ResourcePattern[] = [];
  let minTTL: number | undefined;

  for (const expr of exprs) {
    for (const scope of expr.scopes) {
      scopeSet.add(scope);
    }
    resources.push(...expr.resources);
    if (expr.ttl !== undefined) {
      minTTL = minTTL === undefined ? expr.ttl : Math.min(minTTL, expr.ttl);
    }
  }

  const result: CapabilityExpression = {
    scopes: Array.from(scopeSet),
    resources,
  };

  if (minTTL !== undefined) {
    result.ttl = minTTL;
  }

  return result;
}

/**
 * Restrict an expression by adding deny patterns from the deny expression.
 * The deny expression's resource patterns are converted to deny type.
 * Scopes from the deny expression are NOT removed from the base expression --
 * denial is at the resource level, not the scope level.
 */
export function restrict(
  expr: CapabilityExpression,
  deny: CapabilityExpression
): CapabilityExpression {
  const denyPatterns: ResourcePattern[] = deny.resources.map(r => ({
    pattern: r.pattern,
    type: 'deny' as const,
  }));

  return {
    scopes: [...expr.scopes],
    resources: [...expr.resources, ...denyPatterns],
    ...(expr.ttl !== undefined ? { ttl: expr.ttl } : {}),
  };
}

/**
 * Set a TTL on an expression. If the expression already has a TTL,
 * the minimum of the two is used.
 */
export function withTTL(
  expr: CapabilityExpression,
  ttlMs: number
): CapabilityExpression {
  const effectiveTTL = expr.ttl !== undefined ? Math.min(expr.ttl, ttlMs) : ttlMs;
  return {
    scopes: [...expr.scopes],
    resources: [...expr.resources],
    ttl: effectiveTTL,
  };
}

// ============================================================================
// MATERIALIZATION
// ============================================================================

/**
 * Materialize a CapabilityExpression into a live sandbox Capability.
 *
 * Attenuates from the given parent token, mapping the expression's scopes
 * and resources into the sandbox's capability model.
 *
 * Returns null if the parent token is invalid or the attenuation fails
 * (e.g., requested scopes not available in parent).
 */
export function materialize(
  sandbox: IsomorphicSandbox,
  parentToken: string,
  expr: CapabilityExpression,
  reason: string
): Capability | null {
  const expiresAt = expr.ttl !== undefined ? Date.now() + expr.ttl : undefined;

  return sandbox.attenuate(parentToken, {
    scopes: expr.scopes,
    resources: expr.resources,
    expiresAt,
    reason,
  });
}

// ============================================================================
// PRESET PROFILES
// ============================================================================

/**
 * Pre-built capability profiles for common agent roles.
 */
export const PROFILES = {
  /** Read-only access to all resources */
  readOnly: combine(read('**')),
  /** Network-only access to all domains */
  networkOnly: combine(network('*')),
  /** Researcher: read all, network all, 256MB memory */
  researcher: combine(read('**'), network('*'), memory(256 * 1024 * 1024)),
  /** Worker: read all, write to output, execute, spawn up to 3 children */
  worker: combine(read('**'), write('./output/**'), execute('*'), spawn(3)),
} as const;
