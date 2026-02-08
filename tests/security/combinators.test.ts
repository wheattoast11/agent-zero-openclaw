import { describe, it, expect, beforeEach } from 'vitest';
import {
  read,
  write,
  network,
  execute,
  memory,
  spawn,
  combine,
  restrict,
  withTTL,
  materialize,
  PROFILES,
} from '../../src/security/combinators.js';
import type { CapabilityExpression } from '../../src/security/combinators.js';
import { IsomorphicSandbox } from '../../src/security/sandbox.js';
import { SkillCapabilityManager } from '../../src/security/capabilities.js';

describe('Capability Combinators', () => {
  // ==========================================================================
  // PRIMITIVE COMBINATORS
  // ==========================================================================

  describe('primitive combinators', () => {
    it('read() creates expression with read scope and allow patterns', () => {
      const expr = read('./data/**', './config/*');
      expect(expr.scopes).toEqual(['read']);
      expect(expr.resources).toHaveLength(2);
      expect(expr.resources[0]).toEqual({ pattern: './data/**', type: 'allow' });
      expect(expr.resources[1]).toEqual({ pattern: './config/*', type: 'allow' });
      expect(expr.ttl).toBeUndefined();
    });

    it('write() creates expression with write scope', () => {
      const expr = write('./output/**');
      expect(expr.scopes).toEqual(['write']);
      expect(expr.resources).toHaveLength(1);
      expect(expr.resources[0]).toEqual({ pattern: './output/**', type: 'allow' });
    });

    it('network() creates expression with network scope', () => {
      const expr = network('api.example.com', '*.internal.net');
      expect(expr.scopes).toEqual(['network']);
      expect(expr.resources).toHaveLength(2);
      expect(expr.resources[0]).toEqual({ pattern: 'api.example.com', type: 'allow' });
      expect(expr.resources[1]).toEqual({ pattern: '*.internal.net', type: 'allow' });
    });

    it('execute() creates expression with execute scope', () => {
      const expr = execute('node', 'python3');
      expect(expr.scopes).toEqual(['execute']);
      expect(expr.resources).toHaveLength(2);
      expect(expr.resources[0]).toEqual({ pattern: 'node', type: 'allow' });
      expect(expr.resources[1]).toEqual({ pattern: 'python3', type: 'allow' });
    });

    it('memory() creates expression with memory scope and byte limit pattern', () => {
      const expr = memory(256 * 1024 * 1024);
      expect(expr.scopes).toEqual(['memory']);
      expect(expr.resources).toHaveLength(1);
      expect(expr.resources[0]).toEqual({
        pattern: `memory:bytes:${256 * 1024 * 1024}`,
        type: 'allow',
      });
    });

    it('spawn() creates expression with spawn scope and max children pattern', () => {
      const expr = spawn(5);
      expect(expr.scopes).toEqual(['spawn']);
      expect(expr.resources).toHaveLength(1);
      expect(expr.resources[0]).toEqual({ pattern: 'spawn:*:5', type: 'allow' });
    });
  });

  // ==========================================================================
  // COMPOSITION OPERATORS
  // ==========================================================================

  describe('combine()', () => {
    it('merges scopes and resources from multiple expressions', () => {
      const expr = combine(read('**'), write('./out/**'), network('*'));
      expect(expr.scopes).toContain('read');
      expect(expr.scopes).toContain('write');
      expect(expr.scopes).toContain('network');
      expect(expr.resources).toHaveLength(3);
    });

    it('deduplicates scopes', () => {
      const expr = combine(read('a'), read('b'));
      expect(expr.scopes).toEqual(['read']);
      expect(expr.resources).toHaveLength(2);
    });

    it('uses minimum TTL when multiple expressions have TTLs', () => {
      const a = withTTL(read('**'), 10000);
      const b = withTTL(write('**'), 5000);
      const expr = combine(a, b);
      expect(expr.ttl).toBe(5000);
    });

    it('preserves TTL from single expression with TTL', () => {
      const a = withTTL(read('**'), 10000);
      const b = write('**');
      const expr = combine(a, b);
      expect(expr.ttl).toBe(10000);
    });

    it('no TTL when no expressions have TTL', () => {
      const expr = combine(read('**'), write('**'));
      expect(expr.ttl).toBeUndefined();
    });
  });

  describe('restrict()', () => {
    it('adds deny patterns from the deny expression', () => {
      const base = read('**');
      const denied = read('.env', '.secret/**');
      const expr = restrict(base, denied);

      expect(expr.scopes).toEqual(['read']);
      expect(expr.resources).toHaveLength(3);
      // Original allow pattern
      expect(expr.resources[0]).toEqual({ pattern: '**', type: 'allow' });
      // Deny patterns
      expect(expr.resources[1]).toEqual({ pattern: '.env', type: 'deny' });
      expect(expr.resources[2]).toEqual({ pattern: '.secret/**', type: 'deny' });
    });

    it('preserves TTL from the base expression', () => {
      const base = withTTL(read('**'), 5000);
      const denied = read('.env');
      const expr = restrict(base, denied);
      expect(expr.ttl).toBe(5000);
    });

    it('does not remove scopes from the base expression', () => {
      const base = combine(read('**'), write('**'));
      const denied = write('./protected/**');
      const expr = restrict(base, denied);
      expect(expr.scopes).toContain('read');
      expect(expr.scopes).toContain('write');
    });
  });

  describe('withTTL()', () => {
    it('sets TTL on an expression', () => {
      const expr = withTTL(read('**'), 30000);
      expect(expr.ttl).toBe(30000);
    });

    it('uses minimum TTL when expression already has one', () => {
      const base = withTTL(read('**'), 60000);
      const expr = withTTL(base, 30000);
      expect(expr.ttl).toBe(30000);
    });

    it('keeps existing TTL if it is shorter', () => {
      const base = withTTL(read('**'), 5000);
      const expr = withTTL(base, 30000);
      expect(expr.ttl).toBe(5000);
    });
  });

  // ==========================================================================
  // MATERIALIZATION
  // ==========================================================================

  describe('materialize()', () => {
    let sandbox: IsomorphicSandbox;

    beforeEach(() => {
      sandbox = new IsomorphicSandbox();
    });

    it('creates a valid sandbox capability from an expression', () => {
      const expr = combine(read('**'), write('./output/**'));
      const cap = materialize(sandbox, sandbox.getRootToken(), expr, 'test cap');

      expect(cap).not.toBeNull();
      expect(cap!.scopes).toContain('read');
      expect(cap!.scopes).toContain('write');
      expect(cap!.parent).toBe(sandbox.getRootToken());
      expect(cap!.metadata.reason).toBe('test cap');
    });

    it('materialized capability grants correct scope+resource', () => {
      const expr = combine(read('./data/**'), network('api.example.com'));
      const cap = materialize(sandbox, sandbox.getRootToken(), expr, 'test')!;

      expect(cap).not.toBeNull();

      const readCheck = sandbox.check(cap.token, 'read', './data/file.txt');
      expect(readCheck.allowed).toBe(true);

      const netCheck = sandbox.check(cap.token, 'network', 'api.example.com');
      expect(netCheck.allowed).toBe(true);

      // Should deny write (not in scopes)
      const writeCheck = sandbox.check(cap.token, 'write', './data/file.txt');
      expect(writeCheck.allowed).toBe(false);
    });

    it('returns null for invalid parent token', () => {
      const expr = read('**');
      const cap = materialize(sandbox, 'invalid-token', expr, 'test');
      expect(cap).toBeNull();
    });

    it('sets expiresAt from TTL', () => {
      const now = Date.now();
      const expr = withTTL(read('**'), 60000);
      const cap = materialize(sandbox, sandbox.getRootToken(), expr, 'ttl test');

      expect(cap).not.toBeNull();
      expect(cap!.expiresAt).not.toBeNull();
      // Should be approximately now + 60000
      expect(cap!.expiresAt!).toBeGreaterThanOrEqual(now + 59000);
      expect(cap!.expiresAt!).toBeLessThanOrEqual(now + 61000);
    });

    it('restrict deny patterns prevent access on materialized capability', () => {
      const base = read('**');
      const denied = read('.env');
      const expr = restrict(base, denied);
      const cap = materialize(sandbox, sandbox.getRootToken(), expr, 'restricted')!;

      expect(cap).not.toBeNull();

      // Allowed: general read
      const allowCheck = sandbox.check(cap.token, 'read', 'data/file.txt');
      expect(allowCheck.allowed).toBe(true);

      // Denied: .env
      const denyCheck = sandbox.check(cap.token, 'read', '.env');
      expect(denyCheck.allowed).toBe(false);
    });
  });

  // ==========================================================================
  // PRESET PROFILES
  // ==========================================================================

  describe('PROFILES', () => {
    it('readOnly has read scope with ** pattern', () => {
      expect(PROFILES.readOnly.scopes).toEqual(['read']);
      expect(PROFILES.readOnly.resources).toEqual([{ pattern: '**', type: 'allow' }]);
    });

    it('networkOnly has network scope with * pattern', () => {
      expect(PROFILES.networkOnly.scopes).toEqual(['network']);
      expect(PROFILES.networkOnly.resources).toEqual([{ pattern: '*', type: 'allow' }]);
    });

    it('researcher has read, network, and memory scopes', () => {
      expect(PROFILES.researcher.scopes).toContain('read');
      expect(PROFILES.researcher.scopes).toContain('network');
      expect(PROFILES.researcher.scopes).toContain('memory');
    });

    it('worker has read, write, execute, and spawn scopes', () => {
      expect(PROFILES.worker.scopes).toContain('read');
      expect(PROFILES.worker.scopes).toContain('write');
      expect(PROFILES.worker.scopes).toContain('execute');
      expect(PROFILES.worker.scopes).toContain('spawn');
    });
  });

  // ==========================================================================
  // DSL PARSING (via SkillCapabilityManager)
  // ==========================================================================

  describe('DSL parsing', () => {
    let sandbox: IsomorphicSandbox;
    let manager: SkillCapabilityManager;

    beforeEach(() => {
      sandbox = new IsomorphicSandbox();
      manager = new SkillCapabilityManager(sandbox);
    });

    it('parses read(filesystem:./data/**) & network(api.example.com)', () => {
      const expr = manager.parseDSL('read(filesystem:./data/**) & network(api.example.com)');

      expect(expr.scopes).toContain('read');
      expect(expr.scopes).toContain('network');
      expect(expr.resources).toHaveLength(2);
      // read strips prefix, network does not
      expect(expr.resources.some(r => r.pattern === './data/**')).toBe(true);
      expect(expr.resources.some(r => r.pattern === 'api.example.com')).toBe(true);
    });

    it('parses union operator: read(a) | write(b)', () => {
      const expr = manager.parseDSL('read(a) | write(b)');

      expect(expr.scopes).toContain('read');
      expect(expr.scopes).toContain('write');
      expect(expr.resources).toHaveLength(2);
      expect(expr.resources.some(r => r.pattern === 'a')).toBe(true);
      expect(expr.resources.some(r => r.pattern === 'b')).toBe(true);
    });

    it('& binds tighter than |', () => {
      // "read(a) | write(b) & network(c)" should be "read(a) | (write(b) & network(c))"
      const expr = manager.parseDSL('read(a) | write(b) & network(c)');

      expect(expr.scopes).toContain('read');
      expect(expr.scopes).toContain('write');
      expect(expr.scopes).toContain('network');
      expect(expr.resources).toHaveLength(3);
    });

    it('parses spawn(N) and memory(bytes)', () => {
      const expr = manager.parseDSL('spawn(5) & memory(1024)');
      expect(expr.scopes).toContain('spawn');
      expect(expr.scopes).toContain('memory');
      expect(expr.resources.some(r => r.pattern === 'spawn:*:5')).toBe(true);
      expect(expr.resources.some(r => r.pattern === 'memory:bytes:1024')).toBe(true);
    });

    it('throws on empty expression', () => {
      expect(() => manager.parseDSL('')).toThrow('empty expression');
    });

    it('throws on invalid syntax — missing parentheses', () => {
      expect(() => manager.parseDSL('read')).toThrow();
    });

    it('throws on unknown function name', () => {
      expect(() => manager.parseDSL('delete(everything)')).toThrow();
    });

    it('throws on spawn with non-numeric argument', () => {
      expect(() => manager.parseDSL('spawn(abc)')).toThrow('non-negative integer');
    });

    it('throws on memory with non-positive argument', () => {
      expect(() => manager.parseDSL('memory(-1)')).toThrow('positive integer');
    });
  });
});
