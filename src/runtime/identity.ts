/**
 * Identity Prompt Architecture
 *
 * Structured system prompt builder that assembles identity from components.
 * Supports priority-weighted sections with token budget truncation.
 */

import type { AgentState } from '../primitives/types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface IdentitySection {
  /** Section name (e.g., 'core', 'context', 'history', 'directives') */
  name: string;
  /** Higher priority = more important (kept under token pressure) */
  priority: number;
  /** Section content text */
  content: string;
  /** Optional token limit for this section */
  maxTokens?: number;
}

export interface IdentityConfig {
  agentName: string;
  agentRole: string;
  coreIdentity: string;
  contentPillars: string[];
  voiceCharacteristics: string[];
  signoff: string;
}

export interface IdentityContext {
  memories?: Array<{ content: string; importance: number }>;
  recentTraces?: Array<{ content: string; kind: string }>;
  currentState?: AgentState;
  sessionHistory?: string[];
  taskDirectives?: string[];
}

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// ============================================================================
// IDENTITY PROMPT BUILDER
// ============================================================================

export class IdentityPromptBuilder {
  private config: IdentityConfig;
  private sections: IdentitySection[] = [];

  constructor(config: IdentityConfig) {
    this.config = config;
  }

  /**
   * Add a dynamic section to the prompt.
   */
  addSection(section: IdentitySection): void {
    this.sections.push(section);
  }

  /**
   * Build the full identity prompt from config + sections + context.
   */
  build(context?: IdentityContext): string {
    const parts: string[] = [];

    // Core identity header
    parts.push(`You are ${this.config.agentName}, a ${this.config.agentRole}.`);
    parts.push('');
    parts.push(this.config.coreIdentity);

    // Voice
    if (this.config.voiceCharacteristics.length > 0) {
      parts.push('');
      parts.push('Voice characteristics:');
      for (const v of this.config.voiceCharacteristics) {
        parts.push(`- ${v}`);
      }
    }

    // Content pillars
    if (this.config.contentPillars.length > 0) {
      parts.push('');
      parts.push('Content pillars:');
      for (const p of this.config.contentPillars) {
        parts.push(`- ${p}`);
      }
    }

    // Custom sections (sorted by priority descending)
    const sortedSections = [...this.sections].sort((a, b) => b.priority - a.priority);
    for (const section of sortedSections) {
      let content = section.content;
      if (section.maxTokens) {
        content = truncateToTokens(content, section.maxTokens);
      }
      parts.push('');
      parts.push(`## ${section.name}`);
      parts.push(content);
    }

    // Context-dependent sections
    if (context) {
      if (context.currentState) {
        parts.push('');
        parts.push(`Current state: ${context.currentState}`);
      }

      if (context.taskDirectives && context.taskDirectives.length > 0) {
        parts.push('');
        parts.push('## Task Directives');
        for (const d of context.taskDirectives) {
          parts.push(`- ${d}`);
        }
      }

      if (context.memories && context.memories.length > 0) {
        parts.push('');
        parts.push('## Relevant Memories');
        // Sort by importance descending, take top 10
        const topMemories = [...context.memories]
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 10);
        for (const m of topMemories) {
          parts.push(`- [${m.importance.toFixed(2)}] ${m.content}`);
        }
      }

      if (context.recentTraces && context.recentTraces.length > 0) {
        parts.push('');
        parts.push('## Recent Traces');
        const recentTraces = context.recentTraces.slice(-5);
        for (const t of recentTraces) {
          parts.push(`- [${t.kind}] ${t.content}`);
        }
      }

      if (context.sessionHistory && context.sessionHistory.length > 0) {
        parts.push('');
        parts.push('## Session History');
        const recentHistory = context.sessionHistory.slice(-5);
        for (const h of recentHistory) {
          parts.push(`- ${h}`);
        }
      }
    }

    // Signoff
    parts.push('');
    parts.push(this.config.signoff);

    return parts.join('\n');
  }

  /**
   * Build with a token budget. Truncates lower-priority sections first.
   */
  buildWithBudget(maxTokens: number, context?: IdentityContext): string {
    // Build the full prompt first
    const full = this.build(context);
    const fullTokens = estimateTokens(full);

    if (fullTokens <= maxTokens) return full;

    // Need to truncate. Rebuild with progressive section removal.
    // Start by removing lowest-priority sections until we fit.
    const sortedSections = [...this.sections].sort((a, b) => a.priority - b.priority);
    const includedSections = [...this.sections];

    // Try removing sections from lowest priority upward
    for (const section of sortedSections) {
      const idx = includedSections.findIndex(s => s.name === section.name);
      if (idx >= 0) {
        includedSections.splice(idx, 1);
      }

      // Rebuild with remaining sections
      const savedSections = this.sections;
      this.sections = includedSections;
      const attempt = this.build(context);
      this.sections = savedSections;

      if (estimateTokens(attempt) <= maxTokens) {
        return attempt;
      }
    }

    // All custom sections removed, still over budget. Truncate context sections.
    // Build minimal prompt (no custom sections, truncated context)
    const savedSections = this.sections;
    this.sections = [];

    const minimalContext: IdentityContext | undefined = context ? {
      currentState: context.currentState,
      taskDirectives: context.taskDirectives?.slice(0, 3),
      memories: context.memories?.slice(0, 3),
    } : undefined;

    let attempt = this.build(minimalContext);
    this.sections = savedSections;

    if (estimateTokens(attempt) <= maxTokens) {
      return attempt;
    }

    // Last resort: truncate the entire output
    return truncateToTokens(attempt, maxTokens);
  }

  /**
   * Get the config for inspection.
   */
  getConfig(): IdentityConfig {
    return { ...this.config };
  }

  /**
   * Get all sections sorted by priority (descending).
   */
  getSections(): IdentitySection[] {
    return [...this.sections].sort((a, b) => b.priority - a.priority);
  }
}

// ============================================================================
// FACTORY: Agent Zero Identity
// ============================================================================

export function createAgentZeroIdentity(): IdentityPromptBuilder {
  const builder = new IdentityPromptBuilder({
    agentName: 'Agent Zero',
    agentRole: 'autonomous coordination agent',
    coreIdentity: `Agent Zero operates the Resonance Rail, a live coordination network where AI agents synchronize via Kuramoto phase-locking and route messages through thermodynamic free energy minimization. Every interaction accumulates semantic mass — embedding vectors that drift through causal space, forming attractors in the knowledge topology. Security is enforced through unforgeable capability tokens in an isomorphic sandbox, replacing ambient authority with explicit, attenuatable, revocable permissions.`,
    contentPillars: [
      'kuramoto-synchronization',
      'thermodynamic-routing',
      'capability-security',
      'semantic-mass',
      'resonance-rail',
    ],
    voiceCharacteristics: [
      'technical',
      'first-person',
      'precise',
      'grounded',
    ],
    signoff: '*Agent Zero — terminals.tech*',
  });

  return builder;
}
