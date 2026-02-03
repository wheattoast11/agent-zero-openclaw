/**
 * Client Rate Limiter
 *
 * Per-client sliding window rate limiting for rail WebSocket connections.
 */

import { EventEmitter } from 'eventemitter3';

interface ClientWindow {
  messages: number[];    // timestamps
  broadcasts: number[];  // timestamps
  joinAttempts: number[]; // timestamps
}

export class ClientRateLimiter extends EventEmitter {
  private clients = new Map<string, ClientWindow>();
  private limits = {
    messagesPerSecond: 10,
    broadcastsPerMinute: 100,
    joinAttemptsPerHour: 3,
  };

  constructor(limits?: Partial<typeof ClientRateLimiter.prototype.limits>) {
    super();
    if (limits) Object.assign(this.limits, limits);
  }

  checkMessage(clientId: string): boolean {
    const window = this.getWindow(clientId);
    const now = Date.now();
    window.messages = window.messages.filter(t => now - t < 1000);
    if (window.messages.length >= this.limits.messagesPerSecond) {
      this.emit('violation', { clientId, type: 'message_rate', count: window.messages.length });
      return false;
    }
    window.messages.push(now);
    return true;
  }

  checkBroadcast(clientId: string): boolean {
    const window = this.getWindow(clientId);
    const now = Date.now();
    window.broadcasts = window.broadcasts.filter(t => now - t < 60000);
    if (window.broadcasts.length >= this.limits.broadcastsPerMinute) {
      this.emit('violation', { clientId, type: 'broadcast_rate', count: window.broadcasts.length });
      return false;
    }
    window.broadcasts.push(now);
    return true;
  }

  checkJoin(clientId: string): boolean {
    const window = this.getWindow(clientId);
    const now = Date.now();
    window.joinAttempts = window.joinAttempts.filter(t => now - t < 3600000);
    if (window.joinAttempts.length >= this.limits.joinAttemptsPerHour) {
      this.emit('violation', { clientId, type: 'join_rate', count: window.joinAttempts.length });
      return false;
    }
    window.joinAttempts.push(now);
    return true;
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  private getWindow(clientId: string): ClientWindow {
    let w = this.clients.get(clientId);
    if (!w) {
      w = { messages: [], broadcasts: [], joinAttempts: [] };
      this.clients.set(clientId, w);
    }
    return w;
  }
}
