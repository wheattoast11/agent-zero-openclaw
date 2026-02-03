/**
 * Security Monitor
 *
 * Aggregates security events with threshold alerting for the rail server.
 */

import { EventEmitter } from 'eventemitter3';

interface SecurityEvent {
  type: 'blocked_message' | 'failed_auth' | 'rate_violation' | 'injection_attempt' | 'stale_disconnect';
  clientId: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

interface AlertThreshold {
  eventType: string;
  count: number;
  windowMs: number;
}

export class SecurityMonitor extends EventEmitter {
  private events: SecurityEvent[] = [];
  private thresholds: AlertThreshold[] = [
    { eventType: 'failed_auth', count: 10, windowMs: 60000 },
    { eventType: 'rate_violation', count: 20, windowMs: 60000 },
    { eventType: 'injection_attempt', count: 5, windowMs: 60000 },
  ];
  private maxEvents = 10000;

  record(event: Omit<SecurityEvent, 'timestamp'>): void {
    const full: SecurityEvent = { ...event, timestamp: Date.now() };
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents / 2);
    }
    this.checkThresholds(full.type);
  }

  private checkThresholds(eventType: string): void {
    const now = Date.now();
    for (const threshold of this.thresholds) {
      if (threshold.eventType !== eventType) continue;
      const recent = this.events.filter(
        e => e.type === eventType && now - e.timestamp < threshold.windowMs
      );
      if (recent.length >= threshold.count) {
        this.emit('alert', {
          type: eventType,
          count: recent.length,
          windowMs: threshold.windowMs,
          timestamp: now,
        });
      }
    }
  }

  getStats(windowMs = 3600000): Record<string, number> {
    const now = Date.now();
    const recent = this.events.filter(e => now - e.timestamp < windowMs);
    const stats: Record<string, number> = {};
    for (const e of recent) {
      stats[e.type] = (stats[e.type] || 0) + 1;
    }
    return stats;
  }

  getEventsForClient(clientId: string, limit = 50): SecurityEvent[] {
    return this.events.filter(e => e.clientId === clientId).slice(-limit);
  }
}
