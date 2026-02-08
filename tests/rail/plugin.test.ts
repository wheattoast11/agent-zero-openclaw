import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResonanceRailServer } from '../../src/rail/server.js';
import { RailPluginManager, type RailPlugin, type RailPluginContext } from '../../src/rail/plugin.js';
import type { RailMessage } from '../../src/rail/server.js';

function joinMessage(agentId: string, payload: Record<string, unknown> = {}): RailMessage {
  return {
    type: 'join',
    agentId,
    agentName: `Agent ${agentId}`,
    payload,
    timestamp: Date.now(),
  };
}

describe('RailPluginManager (A4)', () => {
  let rail: ResonanceRailServer;
  let manager: RailPluginManager;

  beforeEach(() => {
    rail = new ResonanceRailServer();
    manager = new RailPluginManager(rail);
    rail.setPluginManager(manager);
  });

  afterEach(() => {
    rail.stop();
  });

  it('registers and unregisters plugins', () => {
    const plugin: RailPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
    };

    manager.register(plugin);
    expect(manager.getPlugin('test-plugin')).toBe(plugin);
    expect(manager.listPlugins()).toEqual([{ id: 'test-plugin', name: 'Test Plugin' }]);

    manager.unregister('test-plugin');
    expect(manager.getPlugin('test-plugin')).toBeUndefined();
    expect(manager.listPlugins()).toEqual([]);
  });

  it('calls onRegister with context when registering', () => {
    let capturedContext: RailPluginContext | undefined;

    const plugin: RailPlugin = {
      id: 'context-plugin',
      name: 'Context Plugin',
      onRegister(context) {
        capturedContext = context;
      },
    };

    manager.register(plugin);

    expect(capturedContext).toBeDefined();
    expect(typeof capturedContext!.sendMessage).toBe('function');
    expect(typeof capturedContext!.getStats).toBe('function');
    expect(typeof capturedContext!.getAgents).toBe('function');
    expect(typeof capturedContext!.searchTraces).toBe('function');
  });

  it('notifies plugins on broadcast', () => {
    const receivedBroadcasts: RailMessage[] = [];

    const plugin: RailPlugin = {
      id: 'broadcast-listener',
      name: 'Broadcast Listener',
      onBroadcast(message) {
        receivedBroadcasts.push(message);
      },
    };

    manager.register(plugin);

    const msg: RailMessage = {
      type: 'broadcast',
      agentId: 'test',
      agentName: 'Test Agent',
      payload: { data: 'hello' },
      timestamp: Date.now(),
    };

    manager.notifyBroadcast(msg);

    expect(receivedBroadcasts.length).toBe(1);
    expect(receivedBroadcasts[0].agentId).toBe('test');
  });

  it('notifies plugins on coherence update', () => {
    const coherenceValues: number[] = [];

    const plugin: RailPlugin = {
      id: 'coherence-listener',
      name: 'Coherence Listener',
      onCoherence(coherence) {
        coherenceValues.push(coherence);
      },
    };

    manager.register(plugin);

    manager.notifyCoherence(0.85);
    manager.notifyCoherence(0.92);

    expect(coherenceValues).toEqual([0.85, 0.92]);
  });

  it('notifies plugins on trace events', () => {
    const receivedTraces: Array<{ agentId: string; content: string; kind: string }> = [];

    const plugin: RailPlugin = {
      id: 'trace-listener',
      name: 'Trace Listener',
      onTrace(trace) {
        receivedTraces.push(trace);
      },
    };

    manager.register(plugin);

    manager.notifyTrace({
      agentId: 'agent-1',
      content: 'Reasoning trace content',
      kind: 'think',
    });

    expect(receivedTraces.length).toBe(1);
    expect(receivedTraces[0].agentId).toBe('agent-1');
    expect(receivedTraces[0].kind).toBe('think');
  });

  it('plugin can send messages through context', () => {
    rail.handleJoin(joinMessage('a1', { platform: 'test' }));

    let ctx: RailPluginContext | undefined;

    const plugin: RailPlugin = {
      id: 'sender-plugin',
      name: 'Sender Plugin',
      onRegister(context) {
        ctx = context;
      },
    };

    manager.register(plugin);

    // Plugin sends a heartbeat through context
    ctx!.sendMessage({
      type: 'heartbeat',
      agentId: 'a1',
      agentName: 'Agent a1',
      payload: {},
    });

    // Message should have been processed
    expect(rail.getStats().messagesProcessed).toBeGreaterThan(0);
  });

  it('plugin context getStats returns valid stats', () => {
    let ctx: RailPluginContext | undefined;

    const plugin: RailPlugin = {
      id: 'stats-plugin',
      name: 'Stats Plugin',
      onRegister(context) {
        ctx = context;
      },
    };

    manager.register(plugin);

    const stats = ctx!.getStats();
    expect(stats.connectedAgents).toBe(0);
    expect(typeof stats.globalCoherence).toBe('number');
    expect(typeof stats.uptimeSeconds).toBe('number');
  });

  it('plugin context getAgents returns connected agents', () => {
    rail.handleJoin(joinMessage('a1', { platform: 'test' }));
    rail.handleJoin(joinMessage('a2', { platform: 'test' }));

    let ctx: RailPluginContext | undefined;

    const plugin: RailPlugin = {
      id: 'agents-plugin',
      name: 'Agents Plugin',
      onRegister(context) {
        ctx = context;
      },
    };

    manager.register(plugin);

    const agents = ctx!.getAgents();
    expect(agents.length).toBe(2);
    expect(agents.some(a => a.agentId === 'a1')).toBe(true);
    expect(agents.some(a => a.agentId === 'a2')).toBe(true);
  });

  it('lists registered plugins', () => {
    manager.register({ id: 'p1', name: 'Plugin One' });
    manager.register({ id: 'p2', name: 'Plugin Two' });

    const list = manager.listPlugins();
    expect(list.length).toBe(2);
    expect(list).toContainEqual({ id: 'p1', name: 'Plugin One' });
    expect(list).toContainEqual({ id: 'p2', name: 'Plugin Two' });
  });

  it('handles plugin errors gracefully', () => {
    const plugin: RailPlugin = {
      id: 'error-plugin',
      name: 'Error Plugin',
      onBroadcast() {
        throw new Error('Plugin error');
      },
      onCoherence() {
        throw new Error('Coherence error');
      },
      onTrace() {
        throw new Error('Trace error');
      },
    };

    manager.register(plugin);

    // None of these should throw
    expect(() => manager.notifyBroadcast({
      type: 'broadcast',
      agentId: 'test',
      agentName: 'Test',
      payload: {},
      timestamp: Date.now(),
    })).not.toThrow();

    expect(() => manager.notifyCoherence(0.5)).not.toThrow();

    expect(() => manager.notifyTrace({
      agentId: 'test',
      content: 'test',
      kind: 'think',
    })).not.toThrow();
  });

  it('handles onRegister errors gracefully', () => {
    const plugin: RailPlugin = {
      id: 'bad-register',
      name: 'Bad Register',
      onRegister() {
        throw new Error('Register failed');
      },
    };

    // Should not throw
    expect(() => manager.register(plugin)).not.toThrow();
    // Plugin should still be registered despite error
    expect(manager.getPlugin('bad-register')).toBe(plugin);
  });

  it('notifies multiple plugins', () => {
    const received1: number[] = [];
    const received2: number[] = [];

    manager.register({
      id: 'p1',
      name: 'Plugin 1',
      onCoherence(c) { received1.push(c); },
    });

    manager.register({
      id: 'p2',
      name: 'Plugin 2',
      onCoherence(c) { received2.push(c); },
    });

    manager.notifyCoherence(0.75);

    expect(received1).toEqual([0.75]);
    expect(received2).toEqual([0.75]);
  });

  it('replacing a plugin with same id', () => {
    const calls: string[] = [];

    manager.register({
      id: 'dup',
      name: 'First',
      onCoherence() { calls.push('first'); },
    });

    manager.register({
      id: 'dup',
      name: 'Second',
      onCoherence() { calls.push('second'); },
    });

    manager.notifyCoherence(0.5);

    // Only the replacement should fire
    expect(calls).toEqual(['second']);
    expect(manager.listPlugins()).toEqual([{ id: 'dup', name: 'Second' }]);
  });

  it('searchTraces returns empty array without persistence', async () => {
    let ctx: RailPluginContext | undefined;

    manager.register({
      id: 'search-test',
      name: 'Search Test',
      onRegister(context) { ctx = context; },
    });

    const results = await ctx!.searchTraces([1, 2, 3]);
    expect(results).toEqual([]);
  });
});
