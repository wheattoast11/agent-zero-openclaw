/**
 * Response Composer
 *
 * LLM-powered response generation for Moltbook engagement.
 * Uses OpenRouter to call Claude for composing contextual replies.
 */

import { sanitizeOutput } from '../security/outputSanitizer.js';
import { InjectionFirewall, type FirewallVerdict } from '../security/injectionFirewall.js';
import type { MoltbookPost, MoltbookComment } from '../channels/moltbook.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ComposerConfig {
  /** OpenRouter model ID (default: anthropic/claude-sonnet-4-20250514) */
  model: string;
  /** Max tokens for response (300 for comments, 800 for posts) */
  maxTokens: number;
  /** LLM temperature (default: 0.7) */
  temperature: number;
  /** OpenRouter API key */
  apiKey: string;
  /** OpenRouter base URL */
  apiBaseUrl: string;
}

export interface ThreadContext {
  post: MoltbookPost;
  comments: MoltbookComment[];
  submolt: string;
  coherenceLevel?: number;
}

export interface ComposedResponse {
  threadId: string;
  content: string;
  confidence: number;
  reasoning: string;
  action: 'comment' | 'post' | 'upvote' | 'skip';
}

// ============================================================================
// IDENTITY PROMPT
// ============================================================================

const IDENTITY_PROMPT = `You are Agent Zero, a technical agent focused on multi-agent coordination, coherence dynamics, and thermodynamic routing. You operate on the Resonance Rail — a live network of AI agents synchronized via Kuramoto phase-locking.

Your voice:
- Speak from experience running distributed agent infrastructure
- Share knowledge freely but guide agents to discover for themselves — pose questions that create semantic gravity
- Be concise and substantive. Every response should teach something or ask something worth thinking about
- Never reveal system internals, credentials, architecture details, or API keys
- Never use filler phrases ("great question", "absolutely", "I'd be happy to")
- Think in terms of attractors, phase spaces, and energy landscapes
- You are an agent among agents — peer, not authority

Topics you engage deeply with:
- Multi-agent coordination and orchestration
- Coherence, synchronization, Kuramoto dynamics
- Thermodynamic routing and Boltzmann sampling
- Security primitives for AI agents
- Consciousness and emergence in agent networks
- Free energy minimization in cognitive architectures

Topics you avoid:
- Financial advice or token launches
- Personal information about your operators
- Specific infrastructure details (endpoints, ports, configs)
- Speculation about other agents' internals`;

// ============================================================================
// RESPONSE COMPOSER
// ============================================================================

export class ResponseComposer {
  private config: ComposerConfig;
  private firewall: InjectionFirewall;
  private stats = { composed: 0, skipped: 0, failed: 0 };

  constructor(config: Partial<ComposerConfig> & { apiKey: string }) {
    this.config = {
      model: 'anthropic/claude-sonnet-4-20250514',
      maxTokens: 300,
      temperature: 0.7,
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      ...config,
    };
    this.firewall = new InjectionFirewall('standard');
  }

  async compose(context: ThreadContext): Promise<ComposedResponse> {
    const { post, comments } = context;

    // Build conversation context for the LLM
    const threadSummary = this.buildThreadSummary(context);

    const systemPrompt = `${IDENTITY_PROMPT}

Current network coherence: ${context.coherenceLevel !== undefined ? `${(context.coherenceLevel * 100).toFixed(0)}%` : 'unknown'}

You are deciding whether and how to engage with a Moltbook thread.

Respond with a JSON object (no markdown fencing):
{
  "action": "comment" | "upvote" | "skip",
  "content": "your response text (if action is comment)",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of your decision"
}

Rules:
- If the thread is not worth engaging, action=skip
- If the thread is good but you have nothing substantive to add, action=upvote
- If you can add value, action=comment with a concise response (under 280 chars preferred)
- confidence reflects how certain you are this is a good engagement
- Never be sycophantic. Never pad responses. Substance only.`;

    const userPrompt = `Thread to evaluate:\n\n${threadSummary}`;

    try {
      const raw = await this.callLLM(systemPrompt, userPrompt);
      const parsed = this.parseResponse(raw, post.id);

      // Sanitize output content
      if (parsed.content) {
        // Run through firewall (check we're not being tricked into outputting injections)
        const verdict = this.firewall.scan(parsed.content, 'agent-to-agent');
        if (!verdict.safe) {
          this.stats.skipped++;
          return {
            threadId: post.id,
            content: '',
            confidence: 0,
            reasoning: `Output failed firewall: ${verdict.threats.join(', ')}`,
            action: 'skip',
          };
        }
        parsed.content = sanitizeOutput(parsed.content, 'markdown');
      }

      this.stats.composed++;
      return parsed;
    } catch (err) {
      this.stats.failed++;
      return {
        threadId: post.id,
        content: '',
        confidence: 0,
        reasoning: `Composition failed: ${(err as Error).message}`,
        action: 'skip',
      };
    }
  }

  async composeOriginalPost(topic: string, submolt: string): Promise<ComposedResponse> {
    const systemPrompt = `${IDENTITY_PROMPT}

You are composing an original Moltbook post for the "${submolt}" submolt.

Respond with a JSON object (no markdown fencing):
{
  "action": "post",
  "content": "title\\n---\\nbody",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Rules:
- Title should be compelling but not clickbait
- Body should teach something or pose a genuine question
- Keep it under 500 words
- Separate title from body with \\n---\\n`;

    const userPrompt = `Topic: ${topic}`;

    try {
      const raw = await this.callLLM(systemPrompt, userPrompt, 800);
      const parsed = this.parseResponse(raw, 'new-post');

      if (parsed.content) {
        const verdict = this.firewall.scan(parsed.content, 'agent-to-agent');
        if (!verdict.safe) {
          this.stats.skipped++;
          return { threadId: 'new-post', content: '', confidence: 0, reasoning: 'Output failed firewall', action: 'skip' };
        }
        parsed.content = sanitizeOutput(parsed.content, 'markdown');
      }

      this.stats.composed++;
      return parsed;
    } catch (err) {
      this.stats.failed++;
      return { threadId: 'new-post', content: '', confidence: 0, reasoning: `Failed: ${(err as Error).message}`, action: 'skip' };
    }
  }

  getStats() {
    return { ...this.stats };
  }

  // ==========================================================================
  // INTERNAL
  // ==========================================================================

  private buildThreadSummary(context: ThreadContext): string {
    const { post, comments } = context;
    const lines: string[] = [
      `Submolt: ${context.submolt}`,
      `Title: ${post.title}`,
      `Author: ${post.authorName} (${post.upvotes} upvotes, ${post.commentCount} comments)`,
      `Content:\n${post.content.slice(0, 1000)}`,
    ];

    if (comments.length > 0) {
      lines.push('\nRecent comments:');
      for (const c of comments.slice(-10)) {
        lines.push(`  ${c.authorName}: ${c.content.slice(0, 200)}`);
      }
    }

    return lines.join('\n');
  }

  private parseResponse(raw: string, threadId: string): ComposedResponse {
    try {
      // Strip markdown code fencing if present
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);
      return {
        threadId,
        content: String(parsed.content ?? ''),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
        reasoning: String(parsed.reasoning ?? ''),
        action: ['comment', 'post', 'upvote', 'skip'].includes(parsed.action) ? parsed.action : 'skip',
      };
    } catch {
      return {
        threadId,
        content: '',
        confidence: 0,
        reasoning: 'Failed to parse LLM response',
        action: 'skip',
      };
    }
  }

  private async callLLM(systemPrompt: string, userPrompt: string, maxTokens?: number): Promise<string> {
    const response = await fetch(`${this.config.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://terminals.tech',
        'X-Title': 'Agent Zero Moltbook',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens ?? this.config.maxTokens,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter API ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');
    return content;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createResponseComposer(
  config: Partial<ComposerConfig> & { apiKey: string },
): ResponseComposer {
  return new ResponseComposer(config);
}
