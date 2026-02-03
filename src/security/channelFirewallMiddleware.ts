/**
 * Channel Firewall Middleware
 *
 * Wraps InjectionFirewall for channel adapters with event emission.
 * Scans incoming content for injection patterns and sanitizes/blocks threats.
 */

import { EventEmitter } from 'eventemitter3';
import { InjectionFirewall, type ParanoiaLevel, type MessageOrigin } from './injectionFirewall.js';

export interface FirewallResult {
  safe: boolean;
  sanitized: string;
  threats: Array<{ pattern: string; score: number; category: string }>;
}

export interface ChannelFirewallMiddleware {
  process(content: string, origin: MessageOrigin): FirewallResult;
  on(event: 'firewall:blocked' | 'firewall:quarantined', handler: (data: any) => void): void;
}

export function createFirewallMiddleware(
  paranoiaLevel: ParanoiaLevel = 'standard'
): ChannelFirewallMiddleware {
  const firewall = new InjectionFirewall(paranoiaLevel);
  const emitter = new EventEmitter();

  return {
    process(content: string, origin: MessageOrigin): FirewallResult {
      const verdict = firewall.scan(content, origin);

      const threats = verdict.threats.map(threat => {
        const [category, pattern] = threat.split(': ');
        return {
          category: category ?? 'unknown',
          pattern: pattern ?? threat,
          score: verdict.score,
        };
      });

      let sanitized = content;
      if (!verdict.safe) {
        sanitized = firewall.quarantine(content);
        emitter.emit('firewall:blocked', {
          origin,
          threats,
          timestamp: Date.now(),
          originalLength: content.length,
          sanitizedLength: sanitized.length,
        });
      } else if (threats.length > 0) {
        emitter.emit('firewall:quarantined', {
          origin,
          threats,
          timestamp: Date.now(),
        });
      }

      return {
        safe: verdict.safe,
        sanitized,
        threats,
      };
    },
    on(event: string, handler: (...args: any[]) => void) {
      emitter.on(event, handler);
    },
  };
}
