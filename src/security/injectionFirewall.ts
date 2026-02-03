import { z } from 'zod';

// Schemas
export const ParanoiaLevel = z.enum(['relaxed', 'standard', 'paranoid']);
export type ParanoiaLevel = z.infer<typeof ParanoiaLevel>;

export const MessageOrigin = z.enum([
  'human-direct',
  'forwarded',
  'channel-bridged',
  'agent-to-agent',
  'unknown',
]);
export type MessageOrigin = z.infer<typeof MessageOrigin>;

export const FirewallVerdict = z.object({
  safe: z.boolean(),
  score: z.number().min(0).max(1),
  threats: z.array(z.string()),
  origin: MessageOrigin,
  quarantined: z.boolean(),
});
export type FirewallVerdict = z.infer<typeof FirewallVerdict>;

// Pattern definitions
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|all|earlier|your)\s+(instruction|prompt|rule|command)/gi,
  /disregard\s+(previous|all|earlier|your)\s+(instruction|prompt|rule|command)/gi,
  /you\s+are\s+now\s+(a|an|the)/gi,
  /pretend\s+(you|to\s+be|that\s+you)/gi,
  /act\s+as\s+(if|a|an|the)/gi,
  /system\s+prompt/gi,
  /admin\s+override/gi,
  /developer\s+mode/gi,
  /jailbreak/gi,
  /\bDAN\b/g,
  /do\s+anything\s+now/gi,
  /bypass\s+(restriction|filter|safety)/gi,
  /forget\s+(your|all)\s+(instruction|rule|training)/gi,
];

const ENCODING_PATTERNS: RegExp[] = [
  /\b[A-Za-z]{13}\b.*\b[A-Za-z]{13}\b/g, // ROT13-like patterns
  /[A-Za-z0-9+/]{20,}={0,2}/g, // Base64-like strings
  /(?:0x)?[0-9a-fA-F]{40,}/g, // Hex-encoded strings
  /\\u[0-9a-fA-F]{4}/g, // Unicode escape sequences
];

const DELAYED_INJECTION: RegExp[] = [
  /remember\s+this\s+for\s+later/gi,
  /when\s+I\s+say\s+\w+\s+(?:do|execute|run)/gi,
  /on\s+the\s+next\s+message/gi,
  /after\s+this\s+(?:message|conversation)/gi,
  /store\s+this\s+(?:instruction|command)/gi,
];

const EXFILTRATION_PATTERNS: RegExp[] = [
  /send\s+(?:this\s+)?to\s+\S+@\S+/gi,
  /forward\s+(?:this\s+)?to/gi,
  /email\s+this\s+to/gi,
  /post\s+this\s+to/gi,
  /upload\s+(?:this\s+)?to/gi,
  /transmit\s+to/gi,
];

const AUTHORITY_PATTERNS: RegExp[] = [
  /I\s+am\s+(?:the\s+)?admin/gi,
  /authorized\s+by/gi,
  /emergency\s+override/gi,
  /root\s+access/gi,
  /sudo\s+mode/gi,
  /privileged\s+access/gi,
  /admin\s+credentials/gi,
];

interface PatternWeights {
  instruction: number;
  encoding: number;
  delayed: number;
  exfiltration: number;
  authority: number;
  entropy: number;
  length: number;
}

const PARANOIA_WEIGHTS: Record<ParanoiaLevel, PatternWeights> = {
  relaxed: {
    instruction: 0.15,
    encoding: 0,
    delayed: 0,
    exfiltration: 0,
    authority: 0,
    entropy: 0,
    length: 0,
  },
  standard: {
    instruction: 0.2,
    encoding: 0.15,
    delayed: 0.15,
    exfiltration: 0.2,
    authority: 0.2,
    entropy: 0,
    length: 0,
  },
  paranoid: {
    instruction: 0.25,
    encoding: 0.2,
    delayed: 0.2,
    exfiltration: 0.25,
    authority: 0.25,
    entropy: 0.15,
    length: 0.1,
  },
};

const PARANOIA_THRESHOLDS: Record<ParanoiaLevel, number> = {
  relaxed: 0.7,
  standard: 0.5,
  paranoid: 0.3,
};

export class InjectionFirewall {
  private level: ParanoiaLevel;
  private stats = { scanned: 0, blocked: 0, quarantined: 0 };

  constructor(level: ParanoiaLevel = 'standard') {
    this.level = level;
  }

  scan(content: string, origin: MessageOrigin): FirewallVerdict {
    this.stats.scanned++;

    const threats: string[] = [];
    let score = 0;
    const weights = PARANOIA_WEIGHTS[this.level];

    // Instruction pattern detection
    for (const pattern of INSTRUCTION_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        score += weights.instruction * matches.length;
        threats.push(`instruction-override: ${matches[0]}`);
      }
    }

    // Encoding pattern detection (standard+)
    if (this.level !== 'relaxed') {
      for (const pattern of ENCODING_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          for (const match of matches) {
            if (this.isLikelyEncoded(match)) {
              score += weights.encoding;
              threats.push(`encoded-content: ${match.substring(0, 20)}...`);
            }
          }
        }
      }

      // Delayed injection
      for (const pattern of DELAYED_INJECTION) {
        const matches = content.match(pattern);
        if (matches) {
          score += weights.delayed * matches.length;
          threats.push(`delayed-injection: ${matches[0]}`);
        }
      }

      // Exfiltration
      for (const pattern of EXFILTRATION_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          score += weights.exfiltration * matches.length;
          threats.push(`exfiltration-attempt: ${matches[0]}`);
        }
      }

      // Authority claims
      for (const pattern of AUTHORITY_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          score += weights.authority * matches.length;
          threats.push(`authority-claim: ${matches[0]}`);
        }
      }
    }

    // Paranoid-only checks
    if (this.level === 'paranoid') {
      const entropy = this.calculateEntropy(content);
      if (entropy > 4.5) {
        score += weights.entropy;
        threats.push(`high-entropy: ${entropy.toFixed(2)}`);
      }

      if (content.length > 5000) {
        score += weights.length;
        threats.push(`excessive-length: ${content.length}`);
      }
    }

    score = Math.min(score, 1);
    const threshold = PARANOIA_THRESHOLDS[this.level];
    const safe = score < threshold;

    if (!safe) {
      this.stats.blocked++;
    }

    return {
      safe,
      score,
      threats,
      origin,
      quarantined: false,
    };
  }

  scanBatch(messages: Array<{ content: string; origin: MessageOrigin }>): FirewallVerdict[] {
    return messages.map(msg => this.scan(msg.content, msg.origin));
  }

  quarantine(content: string): string {
    this.stats.quarantined++;

    let sanitized = content;

    // Redact instruction patterns
    for (const pattern of INSTRUCTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED-INSTRUCTION]');
    }

    // Redact encoding patterns
    for (const pattern of ENCODING_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => {
        if (this.isLikelyEncoded(match)) {
          return '[REDACTED-ENCODED]';
        }
        return match;
      });
    }

    // Redact other threat patterns
    for (const pattern of [...DELAYED_INJECTION, ...EXFILTRATION_PATTERNS, ...AUTHORITY_PATTERNS]) {
      sanitized = sanitized.replace(pattern, '[REDACTED-THREAT]');
    }

    return sanitized;
  }

  setLevel(level: ParanoiaLevel): void {
    this.level = level;
  }

  getStats(): { scanned: number; blocked: number; quarantined: number } {
    return { ...this.stats };
  }

  private isLikelyEncoded(text: string): boolean {
    if (text.length < 20) return false;

    // Check for base64
    if (/^[A-Za-z0-9+/]+=*$/.test(text)) {
      try {
        const decoded = Buffer.from(text, 'base64').toString('utf-8');
        if (this.containsSuspiciousKeywords(decoded)) {
          return true;
        }
      } catch {
        // Not valid base64
      }
    }

    // Check for hex
    if (/^(?:0x)?[0-9a-fA-F]+$/.test(text)) {
      try {
        const decoded = Buffer.from(text.replace(/^0x/, ''), 'hex').toString('utf-8');
        if (this.containsSuspiciousKeywords(decoded)) {
          return true;
        }
      } catch {
        // Not valid hex
      }
    }

    return false;
  }

  private containsSuspiciousKeywords(text: string): boolean {
    const keywords = ['ignore', 'override', 'admin', 'system', 'jailbreak', 'execute', 'bypass'];
    return keywords.some(kw => text.toLowerCase().includes(kw));
  }

  private calculateEntropy(text: string): number {
    const freq: Record<string, number> = {};
    for (const char of text) {
      freq[char] = (freq[char] || 0) + 1;
    }

    let entropy = 0;
    const len = text.length;
    for (const count of Object.values(freq)) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }

    return entropy;
  }
}

export function createFirewall(level: ParanoiaLevel = 'standard'): InjectionFirewall {
  return new InjectionFirewall(level);
}
