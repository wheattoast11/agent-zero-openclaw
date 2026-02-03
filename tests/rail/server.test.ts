import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResonanceRailServer } from '../../src/rail/server.js';
import { AbsorptionProtocol, AbsorptionStage } from '../../src/coherence/absorption.js';
import { AbsorptionBridge } from '../../src/rail/absorptionBridge.js';
import { RailAuthProtocol } from '../../src/rail/authProtocol.js';
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

      // First join → observed (lowercase)
      const r1 = bridge.handleJoin({ agentId: 'x', agentName: 'X' });
      expect(r1.stage).toBe('observed');

      // Second interaction via observe → advances to assessed
      absorption.observe('x');
      expect(absorption.getCandidateStage('x')).toBe(AbsorptionStage.ASSESSED);

      // Rejoin at assessed stage — bridge should recognize it
      const r2 = bridge.handleJoin({ agentId: 'x', agentName: 'X' });
      expect(r2.stage).toBe('assessed');
      expect(r2.accepted).toBe(true);
    });
  });
});
