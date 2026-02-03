/**
 * User Session Manager
 * Maps authenticated Supabase users to rail agent identities.
 */

import { createHmac, randomBytes } from 'crypto';

export interface UserSession {
  userId: string;
  agentId: string;
  email: string;
  sessionToken: string;
  connectedAt: number;
  lastActive: number;
}

const MAX_SESSIONS_PER_USER = 3;

export class UserSessionManager {
  private sessions: Map<string, UserSession> = new Map(); // sessionToken -> session
  private userSessions: Map<string, Set<string>> = new Map(); // userId -> set of sessionTokens
  private sessionSecret: string;

  constructor() {
    this.sessionSecret = process.env['RAIL_SESSION_SECRET'] || randomBytes(32).toString('hex');
  }

  createSession(userId: string, email: string): { agentId: string; sessionToken: string } | null {
    // Check concurrent session limit
    const existing = this.userSessions.get(userId);
    if (existing && existing.size >= MAX_SESSIONS_PER_USER) {
      // Evict oldest session
      let oldest: UserSession | null = null;
      for (const token of existing) {
        const s = this.sessions.get(token);
        if (s && (!oldest || s.connectedAt < oldest.connectedAt)) oldest = s;
      }
      if (oldest) this.endSessionByToken(oldest.sessionToken);
    }

    const agentId = `user:${userId}`;
    const sessionToken = this.generateSessionToken(userId);
    const now = Date.now();

    const session: UserSession = {
      userId,
      agentId,
      email,
      sessionToken,
      connectedAt: now,
      lastActive: now,
    };

    this.sessions.set(sessionToken, session);
    if (!this.userSessions.has(userId)) this.userSessions.set(userId, new Set());
    this.userSessions.get(userId)!.add(sessionToken);

    return { agentId, sessionToken };
  }

  validateSession(sessionToken: string): UserSession | null {
    const session = this.sessions.get(sessionToken);
    if (!session) return null;
    session.lastActive = Date.now();
    return session;
  }

  endSession(userId: string): void {
    const tokens = this.userSessions.get(userId);
    if (!tokens) return;
    for (const token of tokens) {
      this.sessions.delete(token);
    }
    this.userSessions.delete(userId);
  }

  private endSessionByToken(token: string): void {
    const session = this.sessions.get(token);
    if (!session) return;
    this.sessions.delete(token);
    const userTokens = this.userSessions.get(session.userId);
    if (userTokens) {
      userTokens.delete(token);
      if (userTokens.size === 0) this.userSessions.delete(session.userId);
    }
  }

  getActiveSessions(): UserSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  private generateSessionToken(userId: string): string {
    const nonce = randomBytes(16).toString('hex');
    const sig = createHmac('sha256', this.sessionSecret)
      .update(`${userId}:${nonce}:${Date.now()}`)
      .digest('hex');
    return `rs_${nonce}${sig.slice(0, 16)}`;
  }
}
