import { describe, it, expect } from 'vitest';
import { RailAuthProtocol } from '../../src/rail/authProtocol.js';

describe('RailAuthProtocol', () => {
  it('generates 64-char hex secrets', () => {
    const secret = RailAuthProtocol.generateSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates correct auth token', () => {
    const auth = new RailAuthProtocol();
    const secret = RailAuthProtocol.generateSecret();
    auth.registerAgent('agent-1', secret);
    const token = auth.generateAuthToken('agent-1', secret);
    expect(auth.validateAuthToken(token)).toBe(true);
  });

  it('rejects tampered agent id', () => {
    const auth = new RailAuthProtocol();
    const secret = RailAuthProtocol.generateSecret();
    auth.registerAgent('agent-1', secret);
    const token = auth.generateAuthToken('agent-1', secret);
    // Tamper with agentId — signature won't match
    const tampered = { ...token, agentId: 'agent-2' };
    auth.registerAgent('agent-2', secret);
    expect(auth.validateAuthToken(tampered)).toBe(false);
  });

  it('rejects expired tokens (>30s)', () => {
    const auth = new RailAuthProtocol();
    const secret = RailAuthProtocol.generateSecret();
    auth.registerAgent('agent-1', secret);
    const token = auth.generateAuthToken('agent-1', secret);
    // Manually expire
    token.timestamp = Date.now() - 60_000;
    expect(auth.validateAuthToken(token)).toBe(false);
  });

  it('issues and validates one-time reconnect tokens', () => {
    const auth = new RailAuthProtocol();
    const secret = RailAuthProtocol.generateSecret();
    auth.registerAgent('agent-1', secret);
    const reconnect = auth.issueReconnectToken('agent-1');
    expect(reconnect).not.toBeNull();
    expect(auth.validateReconnectToken('agent-1', reconnect!.token)).toBe(true);
    // One-time use — second validation fails
    expect(auth.validateReconnectToken('agent-1', reconnect!.token)).toBe(false);
  });
});
