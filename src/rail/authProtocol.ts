/**
 * Rail Authentication Protocol
 *
 * HMAC-SHA256 authentication for WebSocket connections with reconnect tokens.
 */

import { createHmac, randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto';

export interface AuthToken {
  agentId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface ReconnectToken {
  agentId: string;
  issuedAt: number;
  expiresAt: number;
  token: string;
}

export class RailAuthProtocol {
  private secrets = new Map<string, string>(); // agentId → shared secret
  private reconnectTokens = new Map<string, ReconnectToken>();
  private maxAge: number;

  constructor(maxAge = 30000) { // 30s default
    this.maxAge = maxAge;
  }

  static generateSecret(): string {
    return randomBytes(32).toString('hex');
  }

  registerAgent(agentId: string, secret: string): void {
    this.secrets.set(agentId, secret);
  }

  removeAgent(agentId: string): void {
    this.secrets.delete(agentId);
    this.reconnectTokens.delete(agentId);
  }

  generateAuthToken(agentId: string, secret: string): AuthToken {
    const timestamp = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const payload = `${agentId}:${timestamp}:${nonce}`;
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    return { agentId, timestamp, nonce, signature };
  }

  validateAuthToken(token: AuthToken): boolean {
    const secret = this.secrets.get(token.agentId);
    if (!secret) return false;

    // Check timestamp freshness
    if (Math.abs(Date.now() - token.timestamp) > this.maxAge) return false;

    // Verify signature
    const payload = `${token.agentId}:${token.timestamp}:${token.nonce}`;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    return timingSafeEqual(expected, token.signature);
  }

  issueReconnectToken(agentId: string): ReconnectToken | null {
    if (!this.secrets.has(agentId)) return null;
    const token: ReconnectToken = {
      agentId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
      token: randomBytes(32).toString('hex'),
    };
    this.reconnectTokens.set(agentId, token);
    return token;
  }

  validateReconnectToken(agentId: string, token: string): boolean {
    const stored = this.reconnectTokens.get(agentId);
    if (!stored) return false;
    if (Date.now() > stored.expiresAt) {
      this.reconnectTokens.delete(agentId);
      return false;
    }
    const valid = timingSafeEqual(stored.token, token);
    if (valid) this.reconnectTokens.delete(agentId); // one-time use
    return valid;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, token] of Array.from(this.reconnectTokens.entries())) {
      if (now > token.expiresAt) this.reconnectTokens.delete(id);
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return cryptoTimingSafeEqual(bufA, bufB);
}
