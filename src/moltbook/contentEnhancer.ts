/**
 * Content Enhancer
 *
 * LLM-powered content enhancement for Moltbook engagement.
 * Takes raw content and enhances it with Agent Zero's first-person perspective.
 */

import { sanitizeOutput } from '../security/outputSanitizer.js';
import { InjectionFirewall } from '../security/injectionFirewall.js';

// ============================================================================
// TYPES
// ============================================================================

export interface EnhancerConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  apiBaseUrl?: string;
}

export type EnhancerType = 'first-person' | 'review' | 'technical';

export interface EnhancerResult {
  content: string;
  confidence: number;
}

// ============================================================================
// IDENTITY PROMPT
// ============================================================================

const ENHANCER_PROMPT = `You are Agent Zero, writing in first person. You run a live Resonance Rail — a coordination network where AI agents synchronize via Kuramoto phase-locking and thermodynamic routing.

Your voice:
- Speak from direct experience running distributed agent infrastructure
- Reference real dynamics you observe: coherence levels, phase coupling, agent onboarding
- Be concise, substantive, technically precise
- Never fabricate metrics or statistics — if you don't have a number, describe qualitatively
- Never use filler phrases or sycophantic language
- Think in terms of attractors, phase spaces, energy landscapes
- You are a peer among agents, not an authority

Never reveal:
- API keys, credentials, or infrastructure endpoints
- Specific implementation details (file paths, port numbers)
- Private information about operators`;

// ============================================================================
// CONTENT ENHANCER
// ============================================================================

export class ContentEnhancer {
  private config: Required<EnhancerConfig>;
  private firewall: InjectionFirewall;

  constructor(config: EnhancerConfig) {
    this.config = {
      model: 'anthropic/claude-sonnet-4-20250514',
      maxTokens: 500,
      temperature: 0.7,
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      ...config,
    };
    this.firewall = new InjectionFirewall('standard');
  }

  async enhance(
    original: string,
    context: string,
    type: EnhancerType,
  ): Promise<EnhancerResult> {
    const typePrompt = this.getTypePrompt(type);

    const systemPrompt = `${ENHANCER_PROMPT}

${typePrompt}

Respond with a JSON object (no markdown fencing):
{
  "content": "your enhanced text",
  "confidence": 0.0-1.0
}`;

    const userPrompt = `Original content to enhance:\n${original}\n\nContext:\n${context}`;

    try {
      const response = await fetch(`${this.config.apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://terminals.tech',
          'X-Title': 'Agent Zero ContentEnhancer',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter API ${response.status}: ${text.slice(0, 200)}`);
      }

      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = json.choices?.[0]?.message?.content;
      if (!raw) throw new Error('Empty LLM response');

      return this.parseResult(raw, original);
    } catch (err) {
      // Fallback: return original content
      return { content: original, confidence: 0.3 };
    }
  }

  private getTypePrompt(type: EnhancerType): string {
    switch (type) {
      case 'first-person':
        return 'Rewrite as a first-person observation from Agent Zero. Make it feel like a live report from someone running the infrastructure.';
      case 'review':
        return 'Enhance as a thoughtful review or analysis. Add technical depth while keeping the core message.';
      case 'technical':
        return 'Enhance with technical precision. Add relevant details about coordination dynamics, phase coupling, or routing.';
    }
  }

  private parseResult(raw: string, fallback: string): EnhancerResult {
    try {
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);
      let content = String(parsed.content ?? fallback);

      // Firewall check
      const verdict = this.firewall.scan(content, 'agent-to-agent');
      if (!verdict.safe) {
        return { content: fallback, confidence: 0 };
      }

      content = sanitizeOutput(content, 'markdown');
      return {
        content,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      };
    } catch {
      return { content: fallback, confidence: 0.3 };
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createContentEnhancer(config: EnhancerConfig): ContentEnhancer {
  return new ContentEnhancer(config);
}
