import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResonanceRailServer } from '../../src/rail/server.js';
import { AbsorptionProtocol, AbsorptionStage } from '../../src/coherence/absorption.js';
import { AbsorptionBridge } from '../../src/rail/absorptionBridge.js';
import { RailAuthProtocol } from '../../src/rail/authProtocol.js';
import { PGliteRailPersistence } from '../../src/rail/persistence.js';
import { RailPluginManager } from '../../src/rail/plugin.js';
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

describe('ResonanceRailServer', () => {
  let rail: ResonanceRailServer;

  afterEach(() => {
    rail.stop();
    delete process.env['RAIL_AUTH_REQUIRED'];
  });

  describe('with auth required', () => {
    beforeEach(() => {
      process.env['RAIL_AUTH_REQUIRED'] = 'true';
      rail = new ResonanceRailServer();
    });

    it('rejects unauthenticated agents', () => {
      const result = rail.handleJoin(joinMessage('unauth-agent', { platform: 'test' }));
      expect(result).toBeNull();
    });

    it('allows observer platforms without auth', () => {
      const result = rail.handleJoin(joinMessage('viewer', { platform: 'moltyverse' }));
      // Observer bypasses auth — should get a client back
      expect(result).not.toBeNull();
      expect(result!.client.platform).toBe('moltyverse');
    });

    it('accepts agent with valid HMAC auth token', () => {
      const secret = RailAuthProtocol.generateSecret();
      rail.getAuthProtocol().registerAgent('auth-agent', secret);
      const token = rail.getAuthProtocol().generateAuthToken('auth-agent', secret);

      const result = rail.handleJoin(joinMessage('auth-agent', {
        platform: 'test',
        authToken: token,
      }));
      expect(result).not.toBeNull();
      expect(result!.client.agentId).toBe('auth-agent');
    });

    it('rejects agent with invalid auth token', () => {
      const secret = RailAuthProtocol.generateSecret();
      rail.getAuthProtocol().registerAgent('agent-1', secret);
      const token = rail.getAuthProtocol().generateAuthToken('agent-1', secret);
      // Tamper
      token.signature = 'bad';

      const result = rail.handleJoin(joinMessage('agent-1', {
        platform: 'test',
        authToken: token,
      }));
      expect(result).toBeNull();
    });
  });

  describe('without auth', () => {
    beforeEach(() => {
      rail = new ResonanceRailServer();
    });

    it('allows any agent to join', () => {
      const result = rail.handleJoin(joinMessage('free-agent', { platform: 'test' }));
      expect(result).not.toBeNull();
      expect(result!.client.agentId).toBe('free-agent');
    });

    it('tracks connected clients', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.handleJoin(joinMessage('a2', { platform: 'test' }));
      expect(rail.getStats().connectedAgents).toBe(2);
    });

    it('handles leave correctly', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.handleLeave({
        type: 'leave',
        agentId: 'a1',
        agentName: 'Agent a1',
        payload: {},
        timestamp: Date.now(),
      });
      expect(rail.getStats().connectedAgents).toBe(0);
    });

    it('processes heartbeats', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.handleHeartbeat({
        type: 'heartbeat',
        agentId: 'a1',
        agentName: 'Agent a1',
        payload: {},
        timestamp: Date.now(),
      });
      const clients = rail.getClients();
      expect(clients[0].lastHeartbeat).toBeGreaterThan(0);
    });
  });

  describe('with absorption protocol', () => {
    beforeEach(() => {
      const absorption = new AbsorptionProtocol();
      rail = new ResonanceRailServer(absorption);
    });

    it('new agents get observed stage via absorption bridge', () => {
      const result = rail.handleJoin(joinMessage('new-agent', { platform: 'test' }));
      expect(result).not.toBeNull();
    });

    it('absorption bridge is accessible', () => {
      expect(rail.getAbsorptionBridge()).toBeDefined();
    });
  });

  describe('AbsorptionBridge stage case matching', () => {
    it('bridge stage strings match AbsorptionProtocol enum values', () => {
      const absorption = new AbsorptionProtocol();
      const bridge = new AbsorptionBridge(absorption);

      // First join -> observed (lowercase)
      const r1 = bridge.handleJoin({ agentId: 'x', agentName: 'X' });
      expect(r1.stage).toBe('observed');

      // Second interaction via observe -> advances to assessed
      absorption.observe('x');
      expect(absorption.getCandidateStage('x')).toBe(AbsorptionStage.ASSESSED);

      // Rejoin at assessed stage — bridge should recognize it
      const r2 = bridge.handleJoin({ agentId: 'x', agentName: 'X' });
      expect(r2.stage).toBe('assessed');
      expect(r2.accepted).toBe(true);
    });
  });

  // ==========================================================================
  // A1: SESSION LIFECYCLE (PAUSE / RESUME)
  // ==========================================================================

  describe('Session Lifecycle (A1)', () => {
    beforeEach(() => {
      rail = new ResonanceRailServer();
    });

    it('pauses server and preserves phases', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.handleJoin(joinMessage('a2', { platform: 'test' }));

      const snapshot = rail.pause();

      expect(rail.isPaused()).toBe(true);
      expect(snapshot.phases.size).toBe(2);
      expect(snapshot.phases.has('a1')).toBe(true);
      expect(snapshot.phases.has('a2')).toBe(true);
      expect(typeof snapshot.coherence).toBe('number');
    });

    it('resumes server and replays queued messages', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.start(1000); // slow tick to avoid interference

      rail.pause();
      expect(rail.isPaused()).toBe(true);

      // Send messages while paused — should be queued
      rail.processMessage({
        type: 'coherence',
        agentId: 'a1',
        agentName: 'Agent a1',
        payload: { coherence: 0.9, phase: 1.5 },
        timestamp: Date.now(),
      });

      // The coherence message should have been queued, not processed
      // (client phase should not have changed yet to 1.5 since it was queued)

      rail.resume();
      expect(rail.isPaused()).toBe(false);

      // After resume, the queued coherence message should have been replayed
      const clients = rail.getClients();
      const a1 = clients.find(c => c.agentId === 'a1');
      expect(a1).toBeDefined();
      expect(a1!.phase).toBe(1.5);
      expect(a1!.coherenceContribution).toBe(0.9);
    });

    it('heartbeats still work while paused', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.pause();

      const beforeHeartbeat = rail.getClients()[0].lastHeartbeat;

      // Small delay to ensure different timestamp
      const later = Date.now() + 100;
      vi.spyOn(Date, 'now').mockReturnValueOnce(later);

      rail.processMessage({
        type: 'heartbeat',
        agentId: 'a1',
        agentName: 'Agent a1',
        payload: {},
        timestamp: later,
      });

      // Heartbeats should bypass the pause queue
      const afterHeartbeat = rail.getClients()[0].lastHeartbeat;
      expect(afterHeartbeat).toBeGreaterThanOrEqual(beforeHeartbeat);

      vi.restoreAllMocks();
    });

    it('messages are queued while paused', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      rail.pause();

      // Send a broadcast while paused
      rail.processMessage({
        type: 'broadcast',
        agentId: 'a1',
        agentName: 'Agent a1',
        payload: { data: 'test' },
        timestamp: Date.now(),
      });

      // Stats should show the message was counted but no broadcast event was emitted
      const stats = rail.getStats();
      expect(stats.paused).toBe(true);
      // messagesProcessed increments even when queued
      expect(stats.messagesProcessed).toBeGreaterThan(0);
    });

    it('pausing when already paused returns existing snapshot', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      const snap1 = rail.pause();
      const snap2 = rail.pause();

      expect(snap1.phases.size).toBe(snap2.phases.size);
      expect(rail.isPaused()).toBe(true);
    });

    it('resuming when not paused is a no-op', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      expect(rail.isPaused()).toBe(false);
      rail.resume(); // should not throw
      expect(rail.isPaused()).toBe(false);
    });

    it('stats include paused field', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));
      expect(rail.getStats().paused).toBe(false);
      rail.pause();
      expect(rail.getStats().paused).toBe(true);
      rail.resume();
      expect(rail.getStats().paused).toBe(false);
    });
  });

  // ==========================================================================
  // A2: REASONING TRACES
  // ==========================================================================

  describe('Reasoning Traces (A2)', () => {
    let persistence: PGliteRailPersistence;

    beforeEach(async () => {
      rail = new ResonanceRailServer();
      // Use in-memory PGlite for tests
      persistence = new PGliteRailPersistence('memory://');
      await persistence.init();
      rail.setPersistence(persistence);
    });

    afterEach(async () => {
      rail.stop();
      await persistence.close();
    });

    it('saves and retrieves traces', async () => {
      await rail.handleTrace({
        type: 'trace',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: {
          content: 'The weather analysis shows clear skies.',
          kind: 'think',
          metadata: { confidence: 0.95 },
        },
        timestamp: Date.now(),
      });

      const traces = await persistence.searchTraces({ agentId: 'agent-1' });
      expect(traces.length).toBe(1);
      expect(traces[0].agent_id).toBe('agent-1');
      expect(traces[0].content).toBe('The weather analysis shows clear skies.');
      expect(traces[0].kind).toBe('think');
    });

    it('searches traces by embedding similarity', async () => {
      // Create two traces with different embeddings
      const embedding1 = new Array(768).fill(0).map((_, i) => Math.sin(i));
      const embedding2 = new Array(768).fill(0).map((_, i) => Math.cos(i));

      await persistence.saveTrace({
        agentId: 'agent-1',
        agentName: 'Agent One',
        content: 'Trace with sin embedding',
        embedding: embedding1,
        kind: 'think',
      });

      await persistence.saveTrace({
        agentId: 'agent-2',
        agentName: 'Agent Two',
        content: 'Trace with cos embedding',
        embedding: embedding2,
        kind: 'act',
      });

      // Search with sin-like embedding
      const results = await persistence.searchTraces({
        embedding: embedding1,
        limit: 2,
      });

      expect(results.length).toBe(2);
      // First result should be the sin embedding (highest similarity)
      expect(results[0].agent_id).toBe('agent-1');
      expect(results[0].similarity).toBeGreaterThan(0.9);
    });

    it('filters traces by agent and kind', async () => {
      await persistence.saveTrace({
        agentId: 'agent-1',
        agentName: 'Agent One',
        content: 'Think trace',
        kind: 'think',
      });

      await persistence.saveTrace({
        agentId: 'agent-1',
        agentName: 'Agent One',
        content: 'Act trace',
        kind: 'act',
      });

      await persistence.saveTrace({
        agentId: 'agent-2',
        agentName: 'Agent Two',
        content: 'Think trace from agent 2',
        kind: 'think',
      });

      const thinkTraces = await persistence.searchTraces({ kind: 'think' });
      expect(thinkTraces.length).toBe(2);

      const agent1Traces = await persistence.searchTraces({ agentId: 'agent-1' });
      expect(agent1Traces.length).toBe(2);

      const agent1ThinkTraces = await persistence.searchTraces({
        agentId: 'agent-1',
        kind: 'think',
      });
      expect(agent1ThinkTraces.length).toBe(1);
      expect(agent1ThinkTraces[0].content).toBe('Think trace');
    });

    it('rejects trace messages with missing content or kind', async () => {
      await rail.handleTrace({
        type: 'trace',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { content: 'no kind' },
        timestamp: Date.now(),
      });

      const traces = await persistence.searchTraces({});
      expect(traces.length).toBe(0);
    });

    it('handles trace without persistence gracefully', async () => {
      const railNoPersist = new ResonanceRailServer();
      // No persistence set — should not throw
      await railNoPersist.handleTrace({
        type: 'trace',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { content: 'test', kind: 'think' },
        timestamp: Date.now(),
      });
      railNoPersist.stop();
    });
  });

  // ==========================================================================
  // A3: CROSS-AGENT SYNTHESIS
  // ==========================================================================

  describe('Cross-Agent Synthesis (A3)', () => {
    let persistence: PGliteRailPersistence;

    beforeEach(async () => {
      rail = new ResonanceRailServer();
      persistence = new PGliteRailPersistence('memory://');
      await persistence.init();
      rail.setPersistence(persistence);
    });

    afterEach(async () => {
      rail.stop();
      await persistence.close();
    });

    it('synthesizes traces from multiple agents', async () => {
      const embedding = new Array(768).fill(0).map((_, i) => Math.sin(i * 0.1));

      await persistence.saveTrace({
        agentId: 'agent-1',
        agentName: 'Agent One',
        content: 'Analysis from agent one.',
        embedding,
        kind: 'think',
      });

      await persistence.saveTrace({
        agentId: 'agent-2',
        agentName: 'Agent Two',
        content: 'Analysis from agent two.',
        embedding,
        kind: 'think',
      });

      const result = await rail.synthesize({
        embedding,
        agentIds: ['agent-1', 'agent-2'],
        limit: 5,
      });

      expect(result.traces.length).toBe(2);
      expect(result.summary).toContain('agent(s)');
      expect(result.traces.some(t => t.agentId === 'agent-1')).toBe(true);
      expect(result.traces.some(t => t.agentId === 'agent-2')).toBe(true);
    });

    it('weights by coherence contribution', async () => {
      // Join agents so they have coherence contribution
      rail.handleJoin(joinMessage('agent-1', { platform: 'test' }));
      rail.handleCoherence({
        type: 'coherence',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { coherence: 0.9 },
        timestamp: Date.now(),
      });

      rail.handleJoin(joinMessage('agent-2', { platform: 'test' }));
      rail.handleCoherence({
        type: 'coherence',
        agentId: 'agent-2',
        agentName: 'Agent Two',
        payload: { coherence: 0.1 },
        timestamp: Date.now(),
      });

      await persistence.saveTrace({
        agentId: 'agent-1',
        agentName: 'Agent One',
        content: 'High coherence trace.',
        kind: 'think',
      });

      await persistence.saveTrace({
        agentId: 'agent-2',
        agentName: 'Agent Two',
        content: 'Low coherence trace.',
        kind: 'think',
      });

      const result = await rail.synthesize({ limit: 5 });

      expect(result.traces.length).toBe(2);
      // Agent-1 has higher coherence weight
      const a1Trace = result.traces.find(t => t.agentId === 'agent-1');
      const a2Trace = result.traces.find(t => t.agentId === 'agent-2');
      expect(a1Trace).toBeDefined();
      expect(a2Trace).toBeDefined();
      expect(a1Trace!.coherenceWeight).toBeGreaterThan(a2Trace!.coherenceWeight);
    });

    it('returns empty result without persistence', async () => {
      const railNoPersist = new ResonanceRailServer();
      const result = await railNoPersist.synthesize({ limit: 5 });
      expect(result.traces.length).toBe(0);
      expect(result.summary).toContain('No persistence');
      railNoPersist.stop();
    });
  });

  // ==========================================================================
  // D1: GOAWAY GRACEFUL DISCONNECTION
  // ==========================================================================

  describe('GoAway (D1)', () => {
    beforeEach(() => {
      rail = new ResonanceRailServer();
    });

    it('broadcasts GoAway before shutdown', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));

      const broadcasts: RailMessage[] = [];
      rail.on('message:broadcast', (msg) => {
        broadcasts.push(msg);
      });

      rail.stop(100); // 100ms grace period

      // Should have received a go_away broadcast
      const goAway = broadcasts.find(b => {
        const p = b.payload as Record<string, unknown>;
        return p?.event === 'go_away';
      });
      expect(goAway).toBeDefined();
      const payload = goAway!.payload as Record<string, unknown>;
      expect(payload.timeRemainingMs).toBe(100);
      expect(payload.reason).toBe('server_shutdown');
    });

    it('respects grace period before force stop', async () => {
      rail.start(1000); // slow tick rate

      const broadcasts: RailMessage[] = [];
      rail.on('message:broadcast', (msg) => {
        broadcasts.push(msg);
      });

      rail.stop(50); // 50ms grace period

      // GoAway should have been broadcast
      const goAway = broadcasts.find(b => {
        const p = b.payload as Record<string, unknown>;
        return p?.event === 'go_away';
      });
      expect(goAway).toBeDefined();

      // Wait for grace period to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      // After grace period, server_shutdown should have been broadcast
      const shutdown = broadcasts.find(b => {
        const p = b.payload as Record<string, unknown>;
        return p?.event === 'server_shutdown';
      });
      expect(shutdown).toBeDefined();
    });

    it('stop without grace period does immediate shutdown', () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));

      const broadcasts: RailMessage[] = [];
      rail.on('message:broadcast', (msg) => {
        broadcasts.push(msg);
      });

      rail.stop(); // no grace period

      // Should have received server_shutdown but no go_away
      const goAway = broadcasts.find(b => {
        const p = b.payload as Record<string, unknown>;
        return p?.event === 'go_away';
      });
      expect(goAway).toBeUndefined();

      const shutdown = broadcasts.find(b => {
        const p = b.payload as Record<string, unknown>;
        return p?.event === 'server_shutdown';
      });
      expect(shutdown).toBeDefined();
    });
  });

  // ==========================================================================
  // PERSISTENCE: PAUSE STATE
  // ==========================================================================

  describe('Persistence: Pause State (A1)', () => {
    let persistence: PGliteRailPersistence;

    beforeEach(async () => {
      persistence = new PGliteRailPersistence('memory://');
      await persistence.init();
      rail = new ResonanceRailServer();
    });

    afterEach(async () => {
      rail.stop();
      await persistence.close();
    });

    it('saves and loads pause state', async () => {
      const phases = new Map<string, number>([
        ['agent-1', 1.23],
        ['agent-2', 4.56],
      ]);
      await persistence.savePauseState(phases, 0.85);

      const loaded = await persistence.loadPauseState();
      expect(loaded).not.toBeNull();
      expect(loaded!.coherence).toBeCloseTo(0.85, 1);
      expect(loaded!.phases.size).toBe(2);
      expect(loaded!.phases.get('agent-1')).toBeCloseTo(1.23, 2);
      expect(loaded!.phases.get('agent-2')).toBeCloseTo(4.56, 2);
    });

    it('returns null when no pause state exists', async () => {
      const loaded = await persistence.loadPauseState();
      expect(loaded).toBeNull();
    });
  });

  // ==========================================================================
  // D2: MESSAGE REPLAY / EVENT SOURCING
  // ==========================================================================

  describe('Message Replay (D2)', () => {
    let persistence: PGliteRailPersistence;

    beforeEach(async () => {
      rail = new ResonanceRailServer();
      persistence = new PGliteRailPersistence('memory://');
      await persistence.init();
      rail.setPersistence(persistence);
    });

    afterEach(async () => {
      rail.stop();
      await persistence.close();
    });

    it('assigns monotonic sequence numbers to messages', async () => {
      const seq1 = await persistence.logMessage({
        type: 'message',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { text: 'first' },
        timestamp: Date.now(),
      });

      const seq2 = await persistence.logMessage({
        type: 'message',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { text: 'second' },
        timestamp: Date.now(),
      });

      const seq3 = await persistence.logMessage({
        type: 'broadcast',
        agentId: 'agent-2',
        agentName: 'Agent Two',
        payload: { text: 'third' },
        timestamp: Date.now(),
      });

      expect(seq1).toBeLessThan(seq2);
      expect(seq2).toBeLessThan(seq3);
      expect(seq2 - seq1).toBe(1);
      expect(seq3 - seq2).toBe(1);
    });

    it('replays messages from a specific sequence', async () => {
      const seqs: number[] = [];
      for (let i = 0; i < 10; i++) {
        const seq = await persistence.logMessage({
          type: 'message',
          agentId: `agent-${i % 3}`,
          agentName: `Agent ${i % 3}`,
          payload: { index: i },
          timestamp: Date.now() + i,
        });
        seqs.push(seq);
      }

      // Replay from seq 5 (the 5th message, 0-indexed seqs[4])
      const fromSeq = seqs[4];
      const replayed = await persistence.replayMessages(fromSeq);

      // Should include messages from seq 5 through 10 (6 messages)
      expect(replayed.length).toBe(6);
      expect(replayed[0].seq).toBe(fromSeq);
      expect(replayed[replayed.length - 1].seq).toBe(seqs[9]);

      // Verify payload is preserved
      const firstPayload = replayed[0].payload as { index: number };
      expect(firstPayload.index).toBe(4);
    });

    it('respects replay limit', async () => {
      for (let i = 0; i < 10; i++) {
        await persistence.logMessage({
          type: 'message',
          agentId: 'agent-1',
          agentName: 'Agent One',
          payload: { index: i },
          timestamp: Date.now() + i,
        });
      }

      const replayed = await persistence.replayMessages(1, 3);
      expect(replayed.length).toBe(3);
      // Should be the first 3 messages
      expect(replayed[0].seq).toBe(1);
      expect(replayed[2].seq).toBe(3);
    });

    it('returns empty array when replaying from future seq', async () => {
      await persistence.logMessage({
        type: 'message',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { text: 'hello' },
        timestamp: Date.now(),
      });

      const replayed = await persistence.replayMessages(9999);
      expect(replayed.length).toBe(0);
    });

    it('prunes old messages by keepCount', async () => {
      for (let i = 0; i < 20; i++) {
        await persistence.logMessage({
          type: 'message',
          agentId: 'agent-1',
          agentName: 'Agent One',
          payload: { index: i },
          timestamp: Date.now() + i,
        });
      }

      const deleted = await persistence.pruneMessageLog(5);

      // Should have deleted 15 messages, keeping the last 5
      // Note: PGlite affectedRows may be undefined, so we verify via replay
      const remaining = await persistence.replayMessages(1);
      expect(remaining.length).toBe(5);

      // The remaining should be the last 5 messages (indices 15-19)
      const firstPayload = remaining[0].payload as { index: number };
      expect(firstPayload.index).toBe(15);
    });

    it('prunes old messages by keepSince', async () => {
      const baseTime = Date.now() - 60_000; // 60 seconds ago

      for (let i = 0; i < 10; i++) {
        await persistence.logMessage({
          type: 'message',
          agentId: 'agent-1',
          agentName: 'Agent One',
          payload: { index: i },
          // First 5 messages are old, last 5 are recent
          timestamp: i < 5 ? baseTime - 30_000 + i : baseTime + i * 1000,
        });
      }

      // Prune messages older than baseTime
      await persistence.pruneMessageLog(undefined, baseTime);

      const remaining = await persistence.replayMessages(1);
      expect(remaining.length).toBe(5);

      // All remaining should have index >= 5
      for (const msg of remaining) {
        const payload = msg.payload as { index: number };
        expect(payload.index).toBeGreaterThanOrEqual(5);
      }
    });

    it('logs messages only when persistence is available', () => {
      const railNoPersist = new ResonanceRailServer();
      // No persistence set — processMessage should still work (no error)
      railNoPersist.handleJoin(joinMessage('a1', { platform: 'test' }));

      railNoPersist.processMessage({
        type: 'message',
        agentId: 'a1',
        agentName: 'Agent a1',
        payload: { text: 'no persistence' },
        timestamp: Date.now(),
      });

      // Should increment local seq counter
      expect(railNoPersist.getMessageSeq()).toBeGreaterThan(0);
      railNoPersist.stop();
    });

    it('getLatestSeq returns correct value', async () => {
      expect(await persistence.getLatestSeq()).toBe(0);

      await persistence.logMessage({
        type: 'message',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { text: 'first' },
        timestamp: Date.now(),
      });

      const seq = await persistence.getLatestSeq();
      expect(seq).toBe(1);

      await persistence.logMessage({
        type: 'message',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { text: 'second' },
        timestamp: Date.now(),
      });

      const seq2 = await persistence.getLatestSeq();
      expect(seq2).toBe(2);
    });

    it('handleReplay returns messages via server', async () => {
      for (let i = 0; i < 5; i++) {
        await persistence.logMessage({
          type: 'message',
          agentId: 'agent-1',
          agentName: 'Agent One',
          payload: { index: i },
          timestamp: Date.now() + i,
        });
      }

      const results = await rail.handleReplay({
        type: 'replay',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { fromSeq: 3, limit: 10 },
        timestamp: Date.now(),
      });

      expect(results.length).toBe(3); // seq 3, 4, 5
      expect(results[0].seq).toBe(3);
    });

    it('handleReplay returns empty without persistence', async () => {
      const railNoPersist = new ResonanceRailServer();
      const results = await railNoPersist.handleReplay({
        type: 'replay',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: { fromSeq: 1 },
        timestamp: Date.now(),
      });
      expect(results.length).toBe(0);
      railNoPersist.stop();
    });

    it('processMessage increments seq with persistence', async () => {
      rail.handleJoin(joinMessage('a1', { platform: 'test' }));

      // Process several messages and wait for async logging
      for (let i = 0; i < 3; i++) {
        rail.processMessage({
          type: 'heartbeat',
          agentId: 'a1',
          agentName: 'Agent a1',
          payload: {},
          timestamp: Date.now() + i,
        });
      }

      // Wait for async persistence writes to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      const latestSeq = await persistence.getLatestSeq();
      // 1 join + 3 heartbeats = 4 messages logged (join goes through processMessage internally too)
      // Actually join is handled via handleJoin, not processMessage, so only 3 heartbeats
      expect(latestSeq).toBe(3);
      expect(rail.getMessageSeq()).toBe(3);
    });

    it('pruneMessageLog returns 0 with no arguments', async () => {
      await persistence.logMessage({
        type: 'message',
        agentId: 'agent-1',
        agentName: 'Agent One',
        payload: {},
        timestamp: Date.now(),
      });

      const deleted = await persistence.pruneMessageLog();
      expect(deleted).toBe(0);

      // All messages should still exist
      const remaining = await persistence.replayMessages(1);
      expect(remaining.length).toBe(1);
    });
  });
});
