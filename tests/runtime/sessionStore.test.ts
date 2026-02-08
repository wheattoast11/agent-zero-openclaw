import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentZero } from '../../src/runtime/agent-zero.js';
import {
  InMemorySessionStore,
  FileSessionStore,
  type SessionSnapshot,
} from '../../src/runtime/sessionStore.js';

// ============================================================================
// HELPERS
// ============================================================================

function createAgent(name = 'test-agent', store?: InMemorySessionStore | FileSessionStore): AgentZero {
  return new AgentZero({ name, sessionStore: store });
}

function addMemories(agent: AgentZero, count: number): void {
  for (let i = 0; i < count; i++) {
    agent.receive({
      id: `mem-${i}`,
      kind: 'percept',
      from: '00000000-0000-0000-0000-000000000000',
      payload: `memory-${i}`,
      timestamp: Date.now(),
    });
    agent.processNext();
  }
}

// ============================================================================
// IN-MEMORY SESSION STORE
// ============================================================================

describe('InMemorySessionStore', () => {
  let store: InMemorySessionStore;
  let agent: AgentZero;

  beforeEach(() => {
    store = new InMemorySessionStore();
    agent = createAgent('session-test', store);
  });

  afterEach(() => {
    agent.destroy();
  });

  it('saves and loads snapshot', async () => {
    agent.start('test task');
    const snapshot = await store.save(agent);

    expect(snapshot.id).toBeDefined();
    expect(snapshot.agentId).toBe(agent.id);
    expect(snapshot.agentName).toBe('session-test');
    expect(snapshot.state).toBe('operate');

    const loaded = await store.load(snapshot.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(snapshot.id);
    expect(loaded!.agentId).toBe(snapshot.agentId);
    expect(loaded!.state).toBe('operate');
  });

  it('lists snapshots by agentId', async () => {
    agent.start('task 1');
    await store.save(agent);
    await store.save(agent);

    const agent2 = createAgent('other-agent', store);
    agent2.start('task 2');
    await store.save(agent2);

    const allList = await store.list();
    expect(allList).toHaveLength(3);

    const filtered = await store.list(agent.id);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(e => e.agentId === agent.id)).toBe(true);

    agent2.destroy();
  });

  it('deletes snapshot', async () => {
    agent.start('test task');
    const snapshot = await store.save(agent);

    await store.delete(snapshot.id);
    const loaded = await store.load(snapshot.id);
    expect(loaded).toBeNull();
  });

  it('returns null for missing snapshot', async () => {
    const loaded = await store.load('nonexistent-id');
    expect(loaded).toBeNull();
  });

  it('snapshot preserves memories, tokens, drift, realizability', async () => {
    agent.start('prove theorem');
    addMemories(agent, 3);

    const snapshot = await store.save(agent);

    expect(snapshot.memories).toHaveLength(3);
    expect(snapshot.memories[0].content).toBe('memory-0');
    expect(snapshot.tokens.length).toBeGreaterThan(0);
    expect(snapshot.drift.resonance).toBeDefined();
    expect(snapshot.realizability.formula).toBe('prove theorem');
  });
});

// ============================================================================
// FILE SESSION STORE
// ============================================================================

describe('FileSessionStore', () => {
  let store: FileSessionStore;
  let agent: AgentZero;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-store-'));
    store = new FileSessionStore(tempDir);
    agent = createAgent('file-test', store);
  });

  afterEach(() => {
    agent.destroy();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads snapshot', async () => {
    agent.start('test task');
    const snapshot = await store.save(agent);

    const loaded = await store.load(snapshot.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.agentId).toBe(agent.id);
    expect(loaded!.state).toBe('operate');
  });

  it('lists and deletes', async () => {
    agent.start('test task');
    const s1 = await store.save(agent);
    const s2 = await store.save(agent);

    const list = await store.list();
    expect(list).toHaveLength(2);

    await store.delete(s1.id);
    const afterDelete = await store.list();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].id).toBe(s2.id);
  });

  it('returns null for missing snapshot', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });
});

// ============================================================================
// AGENT ZERO INTEGRATION
// ============================================================================

describe('AgentZero session integration', () => {
  let store: InMemorySessionStore;
  let agent: AgentZero;

  beforeEach(() => {
    store = new InMemorySessionStore();
    agent = createAgent('integration-test', store);
  });

  afterEach(() => {
    agent.destroy();
  });

  it('saveSession creates valid snapshot', async () => {
    agent.start('integration task');
    addMemories(agent, 2);

    const snapshot = await agent.saveSession();
    expect(snapshot.agentName).toBe('integration-test');
    expect(snapshot.state).toBe('operate');
    expect(snapshot.memories).toHaveLength(2);
  });

  it('restoreSession restores state correctly', async () => {
    agent.start('integration task');
    addMemories(agent, 2);

    const snapshot = await agent.saveSession();

    // Modify state after saving
    agent.receive({
      id: 'extra-mem',
      kind: 'percept',
      from: '00000000-0000-0000-0000-000000000000',
      payload: 'post-save-memory',
      timestamp: Date.now(),
    });
    agent.processNext();
    expect(agent.getState().memories).toHaveLength(3);

    // Restore
    await agent.restoreSession(snapshot.id);
    expect(agent.getState().memories).toHaveLength(2);
    expect(agent.getState().state).toBe('operate');
  });

  it('restoreSession throws for missing snapshot', async () => {
    agent.start('test');
    await expect(agent.restoreSession('nonexistent')).rejects.toThrow('Snapshot not found');
  });

  it('saveSession throws without store', async () => {
    const agentNoStore = new AgentZero({ name: 'no-store' });
    agentNoStore.start('test');
    await expect(agentNoStore.saveSession()).rejects.toThrow('No session store configured');
    agentNoStore.destroy();
  });

  it('full save/restore roundtrip preserves all state fields', async () => {
    agent.start('roundtrip task');
    addMemories(agent, 3);

    // Capture pre-save state for comparison (snapshot clones, getState doesn't)
    const snapshot = await agent.saveSession();
    const preMemoryCount = snapshot.memories.length;
    const preDrift = structuredClone(snapshot.drift);
    const preObserverPhase = snapshot.observerPhase;
    const preObserverFrequency = snapshot.observerFrequency;
    const preTokenCount = snapshot.tokens.length;
    const preState = snapshot.state;

    // Mutate state significantly
    agent.receive({
      id: 'extra',
      kind: 'percept',
      from: '00000000-0000-0000-0000-000000000000',
      payload: 'mutation',
      timestamp: Date.now(),
    });
    agent.processNext();

    // Send a resonate message to change phase
    agent.receive({
      id: 'resonate',
      kind: 'resonate',
      from: '00000000-0000-0000-0000-000000000000',
      payload: { phase: 3.14 },
      timestamp: Date.now(),
    });
    agent.processNext();

    // Verify state has changed
    const mutatedState = agent.getState();
    expect(mutatedState.memories.length).toBeGreaterThan(3);

    // Restore and verify all fields match snapshot
    await agent.restoreSession(snapshot.id);
    const restoredState = agent.getState();

    expect(restoredState.memories).toHaveLength(preMemoryCount);
    expect(restoredState.state).toBe(preState);
    expect(restoredState.drift.semanticDistance).toBe(preDrift.semanticDistance);
    expect(restoredState.drift.resonance).toBe(preDrift.resonance);
    expect(restoredState.observer.phase).toBe(preObserverPhase);
    expect(restoredState.observer.frequency).toBe(preObserverFrequency);
    expect(restoredState.realizability.formula).toBe('roundtrip task');
    expect(restoredState.tokens).toHaveLength(preTokenCount);
  });
});
