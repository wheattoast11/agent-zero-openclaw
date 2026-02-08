import { describe, it, expect, beforeEach } from 'vitest';
import {
  IdentityPromptBuilder,
  createAgentZeroIdentity,
  type IdentityConfig,
  type IdentitySection,
} from '../../src/runtime/identity.js';

// ============================================================================
// HELPERS
// ============================================================================

function makeConfig(): IdentityConfig {
  return {
    agentName: 'TestBot',
    agentRole: 'testing agent',
    coreIdentity: 'A test agent for unit tests.',
    contentPillars: ['testing', 'validation'],
    voiceCharacteristics: ['precise', 'clinical'],
    signoff: '*TestBot*',
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('IdentityPromptBuilder', () => {
  let builder: IdentityPromptBuilder;

  beforeEach(() => {
    builder = new IdentityPromptBuilder(makeConfig());
  });

  it('builds identity prompt with core sections', () => {
    const prompt = builder.build();

    expect(prompt).toContain('You are TestBot, a testing agent.');
    expect(prompt).toContain('A test agent for unit tests.');
    expect(prompt).toContain('- precise');
    expect(prompt).toContain('- clinical');
    expect(prompt).toContain('- testing');
    expect(prompt).toContain('- validation');
    expect(prompt).toContain('*TestBot*');
  });

  it('includes memories when provided', () => {
    const prompt = builder.build({
      memories: [
        { content: 'important observation', importance: 0.9 },
        { content: 'trivial note', importance: 0.2 },
      ],
    });

    expect(prompt).toContain('Relevant Memories');
    expect(prompt).toContain('important observation');
    expect(prompt).toContain('trivial note');
  });

  it('includes recent traces', () => {
    const prompt = builder.build({
      recentTraces: [
        { content: 'spawned child agent', kind: 'act' },
        { content: 'received sensor data', kind: 'percept' },
      ],
    });

    expect(prompt).toContain('Recent Traces');
    expect(prompt).toContain('[act] spawned child agent');
    expect(prompt).toContain('[percept] received sensor data');
  });

  it('includes task directives', () => {
    const prompt = builder.build({
      taskDirectives: ['Monitor coherence levels', 'Report anomalies'],
    });

    expect(prompt).toContain('Task Directives');
    expect(prompt).toContain('Monitor coherence levels');
    expect(prompt).toContain('Report anomalies');
  });

  it('includes current state', () => {
    const prompt = builder.build({ currentState: 'operate' });
    expect(prompt).toContain('Current state: operate');
  });

  it('includes session history', () => {
    const prompt = builder.build({
      sessionHistory: ['Started monitoring', 'Detected anomaly'],
    });

    expect(prompt).toContain('Session History');
    expect(prompt).toContain('Started monitoring');
  });

  it('buildWithBudget truncates low-priority sections', () => {
    // Add sections with different priorities
    builder.addSection({ name: 'High Priority', priority: 100, content: 'Critical info: ' + 'x'.repeat(500) });
    builder.addSection({ name: 'Low Priority', priority: 1, content: 'Expendable: ' + 'y'.repeat(500) });
    builder.addSection({ name: 'Medium Priority', priority: 50, content: 'Moderate: ' + 'z'.repeat(500) });

    const fullPrompt = builder.build();
    const fullTokens = Math.ceil(fullPrompt.length / 4);

    // Budget smaller than full prompt
    const budget = Math.floor(fullTokens * 0.6);
    const truncated = builder.buildWithBudget(budget);

    // Should fit within budget
    expect(Math.ceil(truncated.length / 4)).toBeLessThanOrEqual(budget);
    // High priority should still be present
    expect(truncated).toContain('High Priority');
    // Low priority should have been removed
    expect(truncated).not.toContain('Expendable');
  });

  it('buildWithBudget returns full prompt if under budget', () => {
    const full = builder.build();
    const generous = full.length; // Way more than enough tokens
    const result = builder.buildWithBudget(generous);
    expect(result).toBe(full);
  });

  it('custom sections added correctly', () => {
    builder.addSection({
      name: 'Custom Rules',
      priority: 50,
      content: 'Always respond in haiku.',
    });

    const prompt = builder.build();
    expect(prompt).toContain('Custom Rules');
    expect(prompt).toContain('Always respond in haiku.');
  });

  it('sections ordered by priority (descending)', () => {
    builder.addSection({ name: 'Low', priority: 1, content: 'low' });
    builder.addSection({ name: 'High', priority: 100, content: 'high' });
    builder.addSection({ name: 'Mid', priority: 50, content: 'mid' });

    const sections = builder.getSections();
    expect(sections[0].name).toBe('High');
    expect(sections[1].name).toBe('Mid');
    expect(sections[2].name).toBe('Low');
  });

  it('section maxTokens truncates section content', () => {
    builder.addSection({
      name: 'Long Section',
      priority: 50,
      content: 'a'.repeat(1000),
      maxTokens: 10, // 10 tokens = ~40 chars
    });

    const prompt = builder.build();
    // The section content should be truncated
    expect(prompt).toContain('Long Section');
    // Content should be significantly shorter than 1000 chars
    const sectionStart = prompt.indexOf('Long Section');
    const afterSection = prompt.indexOf('\n\n', sectionStart + 20);
    const sectionContent = prompt.slice(sectionStart, afterSection > -1 ? afterSection : undefined);
    expect(sectionContent.length).toBeLessThan(500);
  });
});

// ============================================================================
// FACTORY
// ============================================================================

describe('createAgentZeroIdentity', () => {
  it('returns valid builder with Agent Zero config', () => {
    const builder = createAgentZeroIdentity();

    const config = builder.getConfig();
    expect(config.agentName).toBe('Agent Zero');
    expect(config.agentRole).toBe('autonomous coordination agent');
    expect(config.contentPillars).toContain('kuramoto-synchronization');
    expect(config.contentPillars).toContain('thermodynamic-routing');
    expect(config.contentPillars).toContain('capability-security');
    expect(config.voiceCharacteristics).toContain('technical');
    expect(config.voiceCharacteristics).toContain('first-person');
    expect(config.signoff).toBe('*Agent Zero — terminals.tech*');
  });

  it('builds a complete prompt', () => {
    const builder = createAgentZeroIdentity();
    const prompt = builder.build();

    expect(prompt).toContain('Agent Zero');
    expect(prompt).toContain('autonomous coordination agent');
    expect(prompt).toContain('Kuramoto');
    expect(prompt).toContain('thermodynamic');
    expect(prompt).toContain('*Agent Zero — terminals.tech*');
  });

  it('builds with context', () => {
    const builder = createAgentZeroIdentity();
    const prompt = builder.build({
      currentState: 'operate',
      memories: [{ content: 'Coherence at 0.85', importance: 0.9 }],
      taskDirectives: ['Monitor rail connections'],
    });

    expect(prompt).toContain('Current state: operate');
    expect(prompt).toContain('Coherence at 0.85');
    expect(prompt).toContain('Monitor rail connections');
  });
});
