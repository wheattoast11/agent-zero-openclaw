import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentIsolationManager } from '../../src/security/isolation.js';
import type { IsolationBoundary } from '../../src/security/isolation.js';
import { AgentZero } from '../../src/runtime/agent-zero.js';

describe('AgentIsolationManager', () => {
  let manager: AgentIsolationManager;

  beforeEach(() => {
    manager = new AgentIsolationManager();
  });

  // ==========================================================================
  // BOUNDARY CREATION
  // ==========================================================================

  describe('createBoundary', () => {
    it('creates boundary with correct parent and child IDs', () => {
      const boundary = manager.createBoundary('parent-1', 'child-1');

      expect(boundary.parentId).toBe('parent-1');
      expect(boundary.childId).toBe('child-1');
    });

    it('applies default values when no config provided', () => {
      const boundary = manager.createBoundary('parent-1', 'child-1');

      expect(boundary.maxSpawnDepth).toBe(3);
      expect(boundary.memoryIsolated).toBe(true);
      expect(boundary.sharedScopes).toContain('read');
      expect(boundary.sharedScopes).toContain('write');
      expect(boundary.sharedScopes).toContain('execute');
      expect(boundary.sharedScopes).toContain('memory');
      expect(boundary.sharedScopes).toContain('broadcast');
    });

    it('overrides defaults with provided config', () => {
      const boundary = manager.createBoundary('parent-1', 'child-1', {
        maxSpawnDepth: 5,
        memoryIsolated: false,
        sharedScopes: ['read', 'network'],
      });

      expect(boundary.maxSpawnDepth).toBe(5);
      expect(boundary.memoryIsolated).toBe(false);
      expect(boundary.sharedScopes).toEqual(['read', 'network']);
    });

    it('getBoundary returns the created boundary', () => {
      const boundary = manager.createBoundary('parent-1', 'child-1');
      expect(manager.getBoundary('child-1')).toBe(boundary);
    });
  });

  // ==========================================================================
  // ACCESS CONTROL
  // ==========================================================================

  describe('checkAccess', () => {
    it('allows access for scopes in sharedScopes', () => {
      manager.createBoundary('parent-1', 'child-1', {
        sharedScopes: ['read', 'write', 'network'],
        memoryIsolated: false,
      });

      expect(manager.checkAccess('child-1', 'read', './data/file.txt')).toBe(true);
      expect(manager.checkAccess('child-1', 'write', './output/result.txt')).toBe(true);
      expect(manager.checkAccess('child-1', 'network', 'api.example.com')).toBe(true);
    });

    it('denies access for scopes NOT in sharedScopes', () => {
      manager.createBoundary('parent-1', 'child-1', {
        sharedScopes: ['read'],
      });

      expect(manager.checkAccess('child-1', 'write', './file.txt')).toBe(false);
      expect(manager.checkAccess('child-1', 'admin', 'system')).toBe(false);
      expect(manager.checkAccess('child-1', 'spawn', 'agent:test')).toBe(false);
    });

    it('denies memory access when memoryIsolated is true', () => {
      manager.createBoundary('parent-1', 'child-1', {
        sharedScopes: ['read', 'memory'],
        memoryIsolated: true,
      });

      // Memory is in sharedScopes but memoryIsolated blocks it
      expect(manager.checkAccess('child-1', 'memory', 'parent-memories')).toBe(false);
    });

    it('allows memory access when memoryIsolated is false', () => {
      manager.createBoundary('parent-1', 'child-1', {
        sharedScopes: ['read', 'memory'],
        memoryIsolated: false,
      });

      expect(manager.checkAccess('child-1', 'memory', 'parent-memories')).toBe(true);
    });

    it('denies access when no boundary exists for the child', () => {
      expect(manager.checkAccess('nonexistent', 'read', './file.txt')).toBe(false);
    });
  });

  // ==========================================================================
  // SPAWN DEPTH
  // ==========================================================================

  describe('getSpawnDepth', () => {
    it('root agent (no boundary) has depth 0', () => {
      expect(manager.getSpawnDepth('root-agent')).toBe(0);
    });

    it('direct child has depth 1', () => {
      manager.createBoundary('root', 'child-1');
      expect(manager.getSpawnDepth('child-1')).toBe(1);
    });

    it('grandchild has depth 2', () => {
      manager.createBoundary('root', 'child-1');
      manager.createBoundary('child-1', 'grandchild-1');
      expect(manager.getSpawnDepth('grandchild-1')).toBe(2);
    });

    it('great-grandchild has depth 3', () => {
      manager.createBoundary('root', 'child-1');
      manager.createBoundary('child-1', 'grandchild-1');
      manager.createBoundary('grandchild-1', 'great-grandchild-1');
      expect(manager.getSpawnDepth('great-grandchild-1')).toBe(3);
    });
  });

  describe('canSpawn', () => {
    it('root agent can always spawn', () => {
      expect(manager.canSpawn('root-agent')).toBe(true);
    });

    it('child below maxSpawnDepth can spawn', () => {
      manager.createBoundary('root', 'child-1', { maxSpawnDepth: 3 });
      // child-1 is at depth 1, maxSpawnDepth is 3
      expect(manager.canSpawn('child-1')).toBe(true);
    });

    it('agent at maxSpawnDepth cannot spawn', () => {
      manager.createBoundary('root', 'child-1', { maxSpawnDepth: 2 });
      manager.createBoundary('child-1', 'grandchild-1', { maxSpawnDepth: 2 });
      // grandchild-1 is at depth 2, maxSpawnDepth is 2
      expect(manager.canSpawn('grandchild-1')).toBe(false);
    });

    it('respects override maxDepth parameter', () => {
      manager.createBoundary('root', 'child-1', { maxSpawnDepth: 5 });
      // child-1 is at depth 1, override maxDepth is 1
      expect(manager.canSpawn('child-1', 1)).toBe(false);
    });
  });

  // ==========================================================================
  // BOUNDARY REMOVAL
  // ==========================================================================

  describe('removeBoundary', () => {
    it('removes boundary for child', () => {
      manager.createBoundary('parent-1', 'child-1');
      expect(manager.getBoundary('child-1')).toBeDefined();

      manager.removeBoundary('child-1');
      expect(manager.getBoundary('child-1')).toBeUndefined();
    });

    it('removing nonexistent boundary is a no-op', () => {
      expect(() => manager.removeBoundary('nonexistent')).not.toThrow();
    });

    it('access check fails after boundary removal', () => {
      manager.createBoundary('parent-1', 'child-1', {
        sharedScopes: ['read'],
      });
      expect(manager.checkAccess('child-1', 'read', './file.txt')).toBe(true);

      manager.removeBoundary('child-1');
      expect(manager.checkAccess('child-1', 'read', './file.txt')).toBe(false);
    });
  });
});

// ==========================================================================
// INTEGRATION: AgentZero.spawn() with isolation
// ==========================================================================

describe('AgentZero spawn isolation', () => {
  let agent: AgentZero;

  beforeEach(() => {
    agent = new AgentZero({ name: 'parent-agent' });
    agent.start('test task');
  });

  afterEach(() => {
    agent.destroy();
  });

  it('spawn creates isolation boundary for child', () => {
    const child = agent.spawn({ name: 'child-1' });
    expect(child).not.toBeNull();

    const isoManager = agent.getIsolationManager();
    const boundary = isoManager.getBoundary(child!.id);
    expect(boundary).toBeDefined();
    expect(boundary!.parentId).toBe(agent.id);
    expect(boundary!.childId).toBe(child!.id);
    expect(boundary!.memoryIsolated).toBe(true);
  });

  it('child has parentId set', () => {
    const child = agent.spawn({ name: 'child-1' });
    expect(child).not.toBeNull();
    expect(child!.parentId).toBe(agent.id);
  });

  it('enforces maxSpawnDepth across agent tree', () => {
    // Default maxSpawnDepth is 3
    const child1 = agent.spawn({ name: 'child-1' })!;
    expect(child1).not.toBeNull();
    child1.start('child task');

    const child2 = child1.spawn({ name: 'grandchild-1' })!;
    expect(child2).not.toBeNull();
    child2.start('grandchild task');

    const child3 = child2.spawn({ name: 'great-grandchild-1' })!;
    expect(child3).not.toBeNull();
    child3.start('great-grandchild task');

    // Depth 3 reached — fourth level should fail
    const child4 = child3.spawn({ name: 'too-deep' });
    expect(child4).toBeNull();
  });

  it('child memory isolation prevents parent memory access', () => {
    const child = agent.spawn({ name: 'child-1' })!;
    const isoManager = agent.getIsolationManager();

    // Check that child cannot access parent memories
    expect(isoManager.checkAccess(child.id, 'memory', 'parent-memories')).toBe(false);
  });
});
