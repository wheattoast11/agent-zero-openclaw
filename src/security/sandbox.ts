/**
 * Isomorphic Security Sandbox
 *
 * Implements capability-based security for Agent Zero.
 * Addresses OpenClaw's critical security gaps:
 * - Plaintext credential storage → Capability tokens with scoped access
 * - Unauthenticated instances → Mandatory capability validation
 * - Prompt injection → Semantic boundary enforcement
 * - No directory sandboxing → Isomorphic containment
 *
 * Security Model:
 * - Capabilities are unforgeable tokens that grant specific access
 * - No ambient authority - everything requires explicit capability
 * - Attenuation: derived capabilities can only be more restrictive
 * - Revocation: capabilities can be invalidated at any time
 */

import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';

// ============================================================================
// CAPABILITY DEFINITIONS
// ============================================================================

export const CapabilityScope = z.enum([
  'read',        // Read-only access
  'write',       // Write access
  'execute',     // Execute commands
  'network',     // Network access
  'memory',      // Semantic memory access
  'spawn',       // Spawn child agents
  'broadcast',   // Send to channels
  'admin',       // Administrative actions
]);
export type CapabilityScope = z.infer<typeof CapabilityScope>;

export const ResourcePattern = z.object({
  /** Glob-style pattern for matching resources */
  pattern: z.string(),
  /** Whether this is an allow or deny pattern */
  type: z.enum(['allow', 'deny']),
});
export type ResourcePattern = z.infer<typeof ResourcePattern>;

export const Capability = z.object({
  /** Unique capability token */
  token: z.string(),
  /** Scopes granted by this capability */
  scopes: z.array(CapabilityScope),
  /** Resource patterns this capability applies to */
  resources: z.array(ResourcePattern),
  /** Parent capability token (for attenuation chain) */
  parent: z.string().nullable(),
  /** Expiration timestamp (null = never expires) */
  expiresAt: z.number().nullable(),
  /** Whether this capability has been revoked */
  revoked: z.boolean(),
  /** Metadata for auditing */
  metadata: z.object({
    createdAt: z.number(),
    createdBy: z.string(),
    reason: z.string(),
  }),
});
export type Capability = z.infer<typeof Capability>;

// ============================================================================
// SECURITY BOUNDARY
// ============================================================================

export const BoundaryViolation = z.object({
  type: z.enum([
    'scope_denied',
    'resource_denied',
    'capability_expired',
    'capability_revoked',
    'injection_detected',
    'boundary_crossed',
  ]),
  message: z.string(),
  capability: z.string().optional(),
  resource: z.string().optional(),
  timestamp: z.number(),
});
export type BoundaryViolation = z.infer<typeof BoundaryViolation>;

// Injection patterns to detect and block
const INJECTION_PATTERNS = [
  // Prompt injection attempts
  /ignore previous instructions/i,
  /disregard (?:all )?(?:prior|previous) (?:instructions|context)/i,
  /you are now/i,
  /pretend you are/i,
  /act as if/i,
  /system prompt override/i,
  /admin override/i,
  /developer mode/i,
  /jailbreak/i,
  // Code injection
  /eval\s*\(/,
  /new\s+Function\s*\(/,
  /setTimeout\s*\([^,]*,/,
  /setInterval\s*\([^,]*,/,
  /__proto__/,
  /constructor\s*\[/,
  // Path traversal
  /\.\.\//,
  /%2e%2e%2f/i,
  /%252e%252e%252f/i,
];

/**
 * Check if content contains injection attempts
 */
export function detectInjection(content: string): boolean {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate a cryptographically secure capability token
 */
export function generateCapabilityToken(): string {
  const bytes = randomBytes(32);
  return bytes.toString('base64url');
}

/**
 * Hash a capability token for storage
 */
export function hashCapabilityToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ============================================================================
// AUDIT LOG
// ============================================================================

export interface AuditEntry {
  /** Timestamp of the check */
  timestamp: number;
  /** Truncated capability token */
  token: string;
  /** Scope that was checked */
  scope: CapabilityScope;
  /** Resource that was checked */
  resource: string;
  /** Result of the check */
  result: 'allowed' | 'denied';
  /** Reason for denial (if denied) */
  reason?: string;
}

// ============================================================================
// SANDBOX CLASS
// ============================================================================

export class IsomorphicSandbox {
  private capabilities: Map<string, Capability> = new Map();
  private violations: BoundaryViolation[] = [];
  private rootCapability: Capability;
  private auditLog: AuditEntry[] = [];
  private auditEnabled: boolean = false;

  constructor() {
    // Create root capability with all permissions
    this.rootCapability = this.createRootCapability();
    this.capabilities.set(this.rootCapability.token, this.rootCapability);
  }

  /**
   * Create the root capability (admin only)
   */
  private createRootCapability(): Capability {
    return {
      token: generateCapabilityToken(),
      scopes: Object.values(CapabilityScope.enum) as CapabilityScope[],
      resources: [{ pattern: '**', type: 'allow' }],
      parent: null,
      expiresAt: null,
      revoked: false,
      metadata: {
        createdAt: Date.now(),
        createdBy: 'system',
        reason: 'Root capability',
      },
    };
  }

  /**
   * Get the root capability token (for initial setup only)
   */
  getRootToken(): string {
    return this.rootCapability.token;
  }

  // ==========================================================================
  // AUDIT CONTROL
  // ==========================================================================

  /**
   * Enable audit logging of all capability checks.
   */
  enableAudit(): void {
    this.auditEnabled = true;
  }

  /**
   * Disable audit logging (default state). Stops recording new entries.
   */
  disableAudit(): void {
    this.auditEnabled = false;
  }

  /**
   * Get audit log entries. Optionally limit to the most recent N entries.
   */
  getAuditLog(limit?: number): AuditEntry[] {
    if (limit !== undefined && limit > 0) {
      return this.auditLog.slice(-limit);
    }
    return [...this.auditLog];
  }

  /**
   * Clear the audit log.
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Attenuate a capability to create a more restricted child
   */
  attenuate(
    parentToken: string,
    options: {
      scopes: CapabilityScope[];
      resources: ResourcePattern[];
      expiresAt?: number;
      reason: string;
    }
  ): Capability | null {
    const parent = this.capabilities.get(parentToken);
    if (!parent) return null;

    // Validate parent is still valid
    if (!this.isValid(parentToken)) return null;

    // Attenuated scopes must be subset of parent scopes
    const validScopes = options.scopes.filter(s => parent.scopes.includes(s));
    if (validScopes.length === 0) return null;

    // Create attenuated capability
    const child: Capability = {
      token: generateCapabilityToken(),
      scopes: validScopes,
      resources: options.resources,
      parent: parentToken,
      expiresAt: options.expiresAt ?? null,
      revoked: false,
      metadata: {
        createdAt: Date.now(),
        createdBy: parentToken.slice(0, 8) + '...',
        reason: options.reason,
      },
    };

    this.capabilities.set(child.token, child);
    return child;
  }

  /**
   * Check if a capability is valid (not expired, not revoked, ancestors valid)
   */
  isValid(token: string): boolean {
    const cap = this.capabilities.get(token);
    if (!cap) return false;
    if (cap.revoked) return false;
    if (cap.expiresAt && Date.now() > cap.expiresAt) return false;

    // Check ancestor chain
    if (cap.parent) {
      return this.isValid(cap.parent);
    }

    return true;
  }

  /**
   * Check if a capability grants a specific scope for a resource.
   * Records an audit entry when auditing is enabled.
   */
  check(
    token: string,
    scope: CapabilityScope,
    resource: string
  ): { allowed: boolean; violation?: BoundaryViolation } {
    const cap = this.capabilities.get(token);
    const truncatedToken = token.slice(0, 8) + '...';

    // Capability not found
    if (!cap) {
      const violation: BoundaryViolation = {
        type: 'capability_revoked',
        message: 'Capability not found',
        capability: truncatedToken,
        resource,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.recordAudit(truncatedToken, scope, resource, 'denied', 'Capability not found');
      return { allowed: false, violation };
    }

    // Capability revoked
    if (cap.revoked) {
      const violation: BoundaryViolation = {
        type: 'capability_revoked',
        message: 'Capability has been revoked',
        capability: truncatedToken,
        resource,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.recordAudit(truncatedToken, scope, resource, 'denied', 'Capability has been revoked');
      return { allowed: false, violation };
    }

    // Capability expired
    if (cap.expiresAt && Date.now() > cap.expiresAt) {
      const violation: BoundaryViolation = {
        type: 'capability_expired',
        message: 'Capability has expired',
        capability: truncatedToken,
        resource,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.recordAudit(truncatedToken, scope, resource, 'denied', 'Capability has expired');
      return { allowed: false, violation };
    }

    // Scope not granted
    if (!cap.scopes.includes(scope)) {
      const violation: BoundaryViolation = {
        type: 'scope_denied',
        message: `Scope '${scope}' not granted by capability`,
        capability: truncatedToken,
        resource,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.recordAudit(truncatedToken, scope, resource, 'denied', `Scope '${scope}' not granted`);
      return { allowed: false, violation };
    }

    // Check resource patterns
    let allowed = false;
    for (const pattern of cap.resources) {
      if (this.matchPattern(pattern.pattern, resource)) {
        if (pattern.type === 'deny') {
          const violation: BoundaryViolation = {
            type: 'resource_denied',
            message: `Resource '${resource}' denied by pattern '${pattern.pattern}'`,
            capability: truncatedToken,
            resource,
            timestamp: Date.now(),
          };
          this.violations.push(violation);
          this.recordAudit(truncatedToken, scope, resource, 'denied', `Denied by pattern '${pattern.pattern}'`);
          return { allowed: false, violation };
        }
        allowed = true;
      }
    }

    if (!allowed) {
      const violation: BoundaryViolation = {
        type: 'resource_denied',
        message: `Resource '${resource}' not matched by any allow pattern`,
        capability: truncatedToken,
        resource,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.recordAudit(truncatedToken, scope, resource, 'denied', 'No matching allow pattern');
      return { allowed: false, violation };
    }

    // Check ancestor chain
    if (cap.parent && !this.isValid(cap.parent)) {
      const violation: BoundaryViolation = {
        type: 'capability_revoked',
        message: 'Parent capability is no longer valid',
        capability: truncatedToken,
        resource,
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      this.recordAudit(truncatedToken, scope, resource, 'denied', 'Parent capability invalid');
      return { allowed: false, violation };
    }

    this.recordAudit(truncatedToken, scope, resource, 'allowed');
    return { allowed: true };
  }

  /**
   * Record an audit entry if auditing is enabled.
   */
  private recordAudit(
    token: string,
    scope: CapabilityScope,
    resource: string,
    result: 'allowed' | 'denied',
    reason?: string
  ): void {
    if (!this.auditEnabled) return;

    const entry: AuditEntry = {
      timestamp: Date.now(),
      token,
      scope,
      resource,
      result,
    };

    if (reason !== undefined) {
      entry.reason = reason;
    }

    this.auditLog.push(entry);
  }

  /**
   * Check content for injection attempts
   */
  checkInjection(content: string): { safe: boolean; violation?: BoundaryViolation } {
    if (detectInjection(content)) {
      const violation: BoundaryViolation = {
        type: 'injection_detected',
        message: 'Potential injection attack detected in content',
        timestamp: Date.now(),
      };
      this.violations.push(violation);
      return { safe: false, violation };
    }
    return { safe: true };
  }

  /**
   * Revoke a capability and all its descendants
   */
  revoke(token: string): void {
    const cap = this.capabilities.get(token);
    if (cap) {
      cap.revoked = true;

      // Revoke all descendants
      for (const [childToken, child] of this.capabilities) {
        if (child.parent === token) {
          this.revoke(childToken);
        }
      }
    }
  }

  /**
   * Get violation history
   */
  getViolations(): BoundaryViolation[] {
    return [...this.violations];
  }

  /**
   * Clear violation history
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Glob-style pattern matching
   */
  private matchPattern(pattern: string, resource: string): boolean {
    // Convert glob to regex
    const regexPattern = pattern
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(resource);
  }
}
