/**
 * Skill-Specific Capability Enforcement
 *
 * Extends IsomorphicSandbox with OpenClaw skill integration.
 * Parses SKILL.md frontmatter capability declarations and enforces
 * scoped access during skill execution.
 *
 * Security Model:
 * - Skills declare required capabilities in frontmatter (filesystem, network, spawn, etc.)
 * - SkillCapabilityManager creates attenuated capability from root
 * - All skill operations checked against declared capabilities
 * - Escalation attempts denied and logged as violations
 * - Capability revocation kills tracked processes
 */

import { z } from 'zod';
import {
  IsomorphicSandbox,
  CapabilityScope,
  BoundaryViolation,
  ResourcePattern,
} from './sandbox.js';
import {
  type CapabilityExpression,
  read,
  write,
  network,
  execute,
  spawn,
  memory,
  combine,
} from './combinators.js';

// ============================================================================
// SKILL CAPABILITY SCHEMAS
// ============================================================================

export const SkillCapabilityDeclaration = z.object({
  /** Filesystem access (glob patterns) */
  filesystem: z.array(z.string()).default([]),
  /** Network access (domain patterns) */
  network: z.array(z.string()).default([]),
  /** Max child agents to spawn */
  spawn: z.number().int().nonnegative().default(0),
  /** Memory limit in bytes */
  memory: z.number().int().positive().default(100 * 1024 * 1024), // 100MB default
  /** Execute permission */
  execute: z.boolean().default(false),
});
export type SkillCapabilityDeclaration = z.infer<typeof SkillCapabilityDeclaration>;

export const SkillExecutionContext = z.object({
  /** Skill name */
  skillName: z.string(),
  /** Declared capabilities */
  declaration: SkillCapabilityDeclaration,
  /** Capability token from sandbox */
  capabilityToken: z.string(),
  /** Tracked process ID (if spawned) */
  pid: z.number().nullable(),
  /** Execution start timestamp */
  startedAt: z.number(),
  /** Accumulated violations */
  violations: z.array(BoundaryViolation),
});
export type SkillExecutionContext = z.infer<typeof SkillExecutionContext>;

// ============================================================================
// SKILL CAPABILITY MANAGER
// ============================================================================

export class SkillCapabilityManager {
  private sandbox: IsomorphicSandbox;
  private contexts: Map<string, SkillExecutionContext> = new Map();

  constructor(sandbox: IsomorphicSandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Register a skill and create attenuated capability from root
   */
  registerSkill(name: string, declaration: SkillCapabilityDeclaration): SkillExecutionContext {
    // Map declaration to scopes and resources
    const scopes: CapabilityScope[] = [];
    const resources: ResourcePattern[] = [];

    // Filesystem access
    if (declaration.filesystem.length > 0) {
      scopes.push('read', 'write');
      for (const pattern of declaration.filesystem) {
        resources.push({ pattern, type: 'allow' });
      }
    }

    // Network access
    if (declaration.network.length > 0) {
      scopes.push('network');
      for (const pattern of declaration.network) {
        resources.push({ pattern: `https://${pattern}/**`, type: 'allow' });
        resources.push({ pattern: `http://${pattern}/**`, type: 'allow' });
      }
    }

    // Spawn permission
    if (declaration.spawn > 0) {
      scopes.push('spawn');
      resources.push({ pattern: `spawn:*:${declaration.spawn}`, type: 'allow' });
    }

    // Memory access
    scopes.push('memory');
    resources.push({ pattern: `memory:bytes:${declaration.memory}`, type: 'allow' });

    // Execute permission
    if (declaration.execute) {
      scopes.push('execute');
      resources.push({ pattern: 'exec:**', type: 'allow' });
    }

    // Always allow broadcast for communication
    scopes.push('broadcast');
    resources.push({ pattern: 'channel:**', type: 'allow' });

    // Create attenuated capability
    const rootToken = this.sandbox.getRootToken();
    const capability = this.sandbox.attenuate(rootToken, {
      scopes,
      resources,
      reason: `Skill: ${name}`,
    });

    if (!capability) {
      throw new Error(`Failed to create capability for skill: ${name}`);
    }

    // Create execution context
    const context: SkillExecutionContext = {
      skillName: name,
      declaration,
      capabilityToken: capability.token,
      pid: null,
      startedAt: Date.now(),
      violations: [],
    };

    this.contexts.set(name, context);
    return context;
  }

  /**
   * Check if skill has access to scope+resource
   */
  checkSkillAccess(
    name: string,
    scope: CapabilityScope,
    resource: string
  ): { allowed: boolean; violation?: BoundaryViolation } {
    const context = this.contexts.get(name);
    if (!context) {
      const violation: BoundaryViolation = {
        type: 'capability_revoked',
        message: `Skill '${name}' not registered`,
        resource,
        timestamp: Date.now(),
      };
      return { allowed: false, violation };
    }

    // Delegate to sandbox with skill's token
    const result = this.sandbox.check(context.capabilityToken, scope, resource);

    // Record violation
    if (result.violation) {
      context.violations.push(result.violation);
    }

    return result;
  }

  /**
   * Handle capability escalation attempt
   */
  onCapabilityEscalation(name: string, requestedScope: CapabilityScope): BoundaryViolation {
    const violation: BoundaryViolation = {
      type: 'scope_denied',
      message: `Skill '${name}' attempted escalation to scope '${requestedScope}'`,
      timestamp: Date.now(),
    };

    const context = this.contexts.get(name);
    if (context) {
      context.violations.push(violation);
    }

    return violation;
  }

  /**
   * Revoke skill capability and kill tracked process
   */
  revokeSkill(name: string): void {
    const context = this.contexts.get(name);
    if (!context) return;

    // Revoke capability in sandbox
    this.sandbox.revoke(context.capabilityToken);

    // Kill tracked process if exists
    if (context.pid !== null) {
      try {
        process.kill(context.pid, 'SIGTERM');
      } catch (err) {
        // Process may already be dead, ignore
      }
    }

    this.contexts.delete(name);
  }

  /**
   * List active skills with stats
   */
  listActiveSkills(): Array<{
    name: string;
    scopes: CapabilityScope[];
    uptime: number;
    violationCount: number;
  }> {
    const result: Array<{
      name: string;
      scopes: CapabilityScope[];
      uptime: number;
      violationCount: number;
    }> = [];

    for (const [name, context] of this.contexts) {
      const scopes = this.inferScopesFromDeclaration(context.declaration);
      const uptime = Date.now() - context.startedAt;
      const violationCount = context.violations.length;

      result.push({ name, scopes, uptime, violationCount });
    }

    return result;
  }

  /**
   * Parse capability declaration from SKILL.md frontmatter
   */
  parseDeclarationFromFrontmatter(frontmatter: string): SkillCapabilityDeclaration {
    // Remove frontmatter delimiters
    const content = frontmatter.replace(/^---\n?/, '').replace(/\n?---$/, '');

    // Parse YAML-like frontmatter
    const lines = content.split('\n');
    const parsed: Record<string, unknown> = {};

    let currentKey: string | null = null;
    let currentArray: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Array item
      if (trimmed.startsWith('- ')) {
        if (currentKey) {
          currentArray.push(trimmed.slice(2).trim());
        }
        continue;
      }

      // Flush previous array
      if (currentKey && currentArray.length > 0) {
        parsed[currentKey] = currentArray;
        currentArray = [];
      }

      // Key-value pair
      const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        currentKey = key;

        // Boolean
        if (value === 'true' || value === 'false') {
          parsed[key] = value === 'true';
          currentKey = null;
          continue;
        }

        // Number
        if (/^\d+$/.test(value)) {
          parsed[key] = parseInt(value, 10);
          currentKey = null;
          continue;
        }

        // String (empty value means array follows)
        if (value) {
          parsed[key] = value;
          currentKey = null;
        }
      }
    }

    // Flush final array
    if (currentKey && currentArray.length > 0) {
      parsed[currentKey] = currentArray;
    }

    // Validate and return
    return SkillCapabilityDeclaration.parse(parsed);
  }

  // ==========================================================================
  // DSL PARSER
  // ==========================================================================

  /**
   * Parse a declarative security DSL string into a CapabilityExpression.
   *
   * Syntax:
   *   read(filesystem:./data/**) & network(api.example.com) | write(filesystem:./output/**)
   *
   * Operators:
   *   & = combine (both granted, higher precedence)
   *   | = union (either granted, lower precedence)
   *
   * NOTE: In the current capability model, both & and | resolve to `combine()`
   * because capabilities are additive scope sets — "grant A and B" and "grant
   * A or B" both result in the union of scopes. A future `intersect()` combinator
   * would make & restrict to the overlap, but this is not yet implemented.
   * The two operators are preserved for DSL readability and forward compatibility.
   *
   * Functions:
   *   read(pattern), write(pattern), network(domain),
   *   execute(binary), spawn(N), memory(bytes)
   *
   * Parentheses are used for function arguments, not grouping of expressions.
   *
   * Precedence: & binds tighter than |
   *   "A | B & C" = "A | (B & C)"
   */
  parseDSL(dsl: string): CapabilityExpression {
    const tokens = this.tokenizeDSL(dsl);
    if (tokens.length === 0) {
      throw new Error('DSL parse error: empty expression');
    }
    const result = this.parseDSLUnion(tokens, { pos: 0 });
    return result;
  }

  /**
   * Tokenize DSL string into an array of tokens.
   * Token types: 'func' (e.g. read), 'lparen', 'rparen', 'and', 'or', 'arg' (argument text)
   */
  private tokenizeDSL(dsl: string): Array<{ type: string; value: string }> {
    const tokens: Array<{ type: string; value: string }> = [];
    let i = 0;
    const s = dsl.trim();

    while (i < s.length) {
      // Skip whitespace
      if (/\s/.test(s[i])) {
        i++;
        continue;
      }

      // Operators
      if (s[i] === '&') {
        tokens.push({ type: 'and', value: '&' });
        i++;
        continue;
      }
      if (s[i] === '|') {
        tokens.push({ type: 'or', value: '|' });
        i++;
        continue;
      }
      if (s[i] === '(') {
        tokens.push({ type: 'lparen', value: '(' });
        i++;
        continue;
      }
      if (s[i] === ')') {
        tokens.push({ type: 'rparen', value: ')' });
        i++;
        continue;
      }

      // Identifiers / arguments: everything that's not an operator or paren
      let start = i;
      while (i < s.length && !/[&|()]/.test(s[i]) && !/^\s$/.test(s[i])) {
        i++;
      }
      const word = s.slice(start, i).trim();
      if (word.length > 0) {
        // Check if it's a known function name
        const funcNames = ['read', 'write', 'network', 'execute', 'spawn', 'memory'];
        if (funcNames.includes(word)) {
          tokens.push({ type: 'func', value: word });
        } else {
          tokens.push({ type: 'arg', value: word });
        }
      }
    }

    return tokens;
  }

  /**
   * Parse union (|) level — lowest precedence.
   * union = intersection (| intersection)*
   */
  private parseDSLUnion(
    tokens: Array<{ type: string; value: string }>,
    cursor: { pos: number }
  ): CapabilityExpression {
    let left = this.parseDSLIntersection(tokens, cursor);

    while (cursor.pos < tokens.length && tokens[cursor.pos].type === 'or') {
      cursor.pos++; // consume |
      const right = this.parseDSLIntersection(tokens, cursor);
      left = combine(left, right);
    }

    return left;
  }

  /**
   * Parse intersection (&) level — higher precedence than |.
   * intersection = primary (& primary)*
   */
  private parseDSLIntersection(
    tokens: Array<{ type: string; value: string }>,
    cursor: { pos: number }
  ): CapabilityExpression {
    let left = this.parseDSLPrimary(tokens, cursor);

    while (cursor.pos < tokens.length && tokens[cursor.pos].type === 'and') {
      cursor.pos++; // consume &
      const right = this.parseDSLPrimary(tokens, cursor);
      left = combine(left, right);
    }

    return left;
  }

  /**
   * Parse primary: func(arg)
   */
  private parseDSLPrimary(
    tokens: Array<{ type: string; value: string }>,
    cursor: { pos: number }
  ): CapabilityExpression {
    if (cursor.pos >= tokens.length) {
      throw new Error('DSL parse error: unexpected end of expression');
    }

    const token = tokens[cursor.pos];

    if (token.type !== 'func') {
      throw new Error(`DSL parse error: expected function name, got '${token.value}'`);
    }

    const funcName = token.value;
    cursor.pos++; // consume func name

    // Expect '('
    if (cursor.pos >= tokens.length || tokens[cursor.pos].type !== 'lparen') {
      throw new Error(`DSL parse error: expected '(' after '${funcName}'`);
    }
    cursor.pos++; // consume (

    // Collect argument tokens until ')'
    const argParts: string[] = [];
    while (cursor.pos < tokens.length && tokens[cursor.pos].type !== 'rparen') {
      argParts.push(tokens[cursor.pos].value);
      cursor.pos++;
    }

    if (cursor.pos >= tokens.length || tokens[cursor.pos].type !== 'rparen') {
      throw new Error(`DSL parse error: expected ')' to close '${funcName}('`);
    }
    cursor.pos++; // consume )

    const arg = argParts.join('');

    // Strip optional type prefix (e.g., "filesystem:" or "api.example.com")
    const colonIdx = arg.indexOf(':');
    const cleanArg = colonIdx >= 0 ? arg.slice(colonIdx + 1) : arg;

    switch (funcName) {
      case 'read':
        return read(cleanArg);
      case 'write':
        return write(cleanArg);
      case 'network':
        return network(arg); // network uses the full domain, no prefix stripping
      case 'execute':
        return execute(cleanArg);
      case 'spawn': {
        const n = parseInt(arg, 10);
        if (isNaN(n) || n < 0) {
          throw new Error(`DSL parse error: spawn requires a non-negative integer, got '${arg}'`);
        }
        return spawn(n);
      }
      case 'memory': {
        const bytes = parseInt(arg, 10);
        if (isNaN(bytes) || bytes <= 0) {
          throw new Error(`DSL parse error: memory requires a positive integer, got '${arg}'`);
        }
        return memory(bytes);
      }
      default:
        throw new Error(`DSL parse error: unknown function '${funcName}'`);
    }
  }

  /**
   * Infer scopes from declaration
   */
  private inferScopesFromDeclaration(declaration: SkillCapabilityDeclaration): CapabilityScope[] {
    const scopes: CapabilityScope[] = [];

    if (declaration.filesystem.length > 0) {
      scopes.push('read', 'write');
    }
    if (declaration.network.length > 0) {
      scopes.push('network');
    }
    if (declaration.spawn > 0) {
      scopes.push('spawn');
    }
    if (declaration.execute) {
      scopes.push('execute');
    }

    scopes.push('memory', 'broadcast'); // Always granted
    return scopes;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSkillCapabilityManager(sandbox: IsomorphicSandbox): SkillCapabilityManager {
  return new SkillCapabilityManager(sandbox);
}
