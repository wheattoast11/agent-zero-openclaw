import { describe, it, expect, beforeEach } from 'vitest';
import { StrategicContextStore, type EngagementRecord } from '../../src/moltbook/strategicContext.js';

function makeEngagement(overrides: Partial<Omit<EngagementRecord, 'id'>> = {}): Omit<EngagementRecord, 'id'> {
  return {
    threadId: 'thread-1',
    threadTitle: 'Kuramoto synchronization in multi-agent systems',
    action: 'comment',
    content: 'Phase-locking enables coherence across distributed agents.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('StrategicContextStore', () => {
  let store: StrategicContextStore;

  beforeEach(() => {
    store = new StrategicContextStore();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ENGAGEMENT RECORDING
  // ──────────────────────────────────────────────────────────────────────────

  it('records engagement and assigns ID', () => {
    const record = store.recordEngagement(makeEngagement());
    expect(record.id).toBeDefined();
    expect(record.id).toHaveLength(36); // UUID
    expect(record.threadId).toBe('thread-1');
    expect(record.action).toBe('comment');
  });

  it('updates outcome for engagement', () => {
    const record = store.recordEngagement(makeEngagement());
    expect(record.outcome).toBeUndefined();

    store.updateOutcome(record.id, {
      upvotes: 5,
      replies: 3,
      engagement: 0.8,
      measuredAt: Date.now(),
    });

    const history = store.getThreadHistory('thread-1');
    expect(history[0].outcome).toBeDefined();
    expect(history[0].outcome!.upvotes).toBe(5);
    expect(history[0].outcome!.replies).toBe(3);
    expect(history[0].outcome!.engagement).toBe(0.8);
  });

  it('getThreadHistory returns correct records', () => {
    store.recordEngagement(makeEngagement({ threadId: 'thread-1' }));
    store.recordEngagement(makeEngagement({ threadId: 'thread-2' }));
    store.recordEngagement(makeEngagement({ threadId: 'thread-1', action: 'upvote' }));

    const history = store.getThreadHistory('thread-1');
    expect(history).toHaveLength(2);
    expect(history[0].threadId).toBe('thread-1');
    expect(history[1].threadId).toBe('thread-1');
  });

  it('hasEngaged returns true for engaged threads', () => {
    store.recordEngagement(makeEngagement({ threadId: 'thread-1', action: 'comment' }));
    expect(store.hasEngaged('thread-1')).toBe(true);
  });

  it('hasEngaged returns false for skip-only threads', () => {
    store.recordEngagement(makeEngagement({ threadId: 'thread-3', action: 'skip' }));
    expect(store.hasEngaged('thread-3')).toBe(false);
  });

  it('hasEngaged returns false for unknown threads', () => {
    expect(store.hasEngaged('thread-999')).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // NARRATIVE ARCS
  // ──────────────────────────────────────────────────────────────────────────

  it('creates narrative arcs from topic keywords', () => {
    const arc = store.getOrCreateArc('kuramoto-synchronization');
    expect(arc.id).toBeDefined();
    expect(arc.topic).toBe('kuramoto-synchronization');
    expect(arc.status).toBe('active');
    expect(arc.engagements).toHaveLength(0);
  });

  it('getOrCreateArc returns existing arc', () => {
    const arc1 = store.getOrCreateArc('kuramoto-synchronization');
    const arc2 = store.getOrCreateArc('kuramoto-synchronization');
    expect(arc1.id).toBe(arc2.id);
  });

  it('links engagements to arcs', () => {
    const record = store.recordEngagement(makeEngagement());
    const arc = store.getOrCreateArc('kuramoto-synchronization');
    store.linkEngagementToArc(record.id, arc.id);

    const activeArcs = store.getActiveArcs();
    expect(activeArcs).toHaveLength(1);
    expect(activeArcs[0].engagements).toContain(record.id);
  });

  it('getActiveArcs filters by status', () => {
    const active = store.getOrCreateArc('kuramoto-synchronization');
    const dormant = store.getOrCreateArc('old-topic');
    dormant.status = 'dormant';

    const activeArcs = store.getActiveArcs();
    expect(activeArcs).toHaveLength(1);
    expect(activeArcs[0].topic).toBe('kuramoto-synchronization');
  });

  it('calculateMomentum reflects recent activity', () => {
    const eng1 = store.recordEngagement(makeEngagement({
      timestamp: Date.now() - 1000,
    }));
    store.updateOutcome(eng1.id, { upvotes: 5, replies: 3, engagement: 0.8, measuredAt: Date.now() });

    const eng2 = store.recordEngagement(makeEngagement({
      timestamp: Date.now() - 2000,
    }));
    store.updateOutcome(eng2.id, { upvotes: 3, replies: 2, engagement: 0.6, measuredAt: Date.now() });

    const arc = store.getOrCreateArc('test-topic');
    arc.engagements = [eng1.id, eng2.id];

    const momentum = store.calculateMomentum(arc);
    // 2 engagements in 7 days: (2/7) * avg(0.8, 0.6) = 0.2857 * 0.7 = 0.2
    expect(momentum).toBeGreaterThan(0);
    expect(momentum).toBeLessThanOrEqual(1);
  });

  it('dormant arcs have low momentum', () => {
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
    const eng = store.recordEngagement(makeEngagement({
      timestamp: Date.now() - EIGHT_DAYS,
    }));

    const arc = store.getOrCreateArc('old-topic');
    arc.engagements = [eng.id];

    const momentum = store.calculateMomentum(arc);
    expect(momentum).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ARC DETECTION
  // ──────────────────────────────────────────────────────────────────────────

  it('detectArcs groups by content pillars', () => {
    const eng1 = store.recordEngagement(makeEngagement({
      threadTitle: 'Kuramoto synchronization in multi-agent systems',
      content: 'Phase-locking is fundamental to coherence.',
      timestamp: Date.now() - 1000,
    }));

    const eng2 = store.recordEngagement(makeEngagement({
      threadId: 'thread-2',
      threadTitle: 'Coherence dynamics and oscillator coupling',
      content: 'Kuramoto model shows emergent synchronization.',
      timestamp: Date.now() - 2000,
    }));

    // Different pillar — should not merge
    const eng3 = store.recordEngagement(makeEngagement({
      threadId: 'thread-3',
      threadTitle: 'Thermodynamic routing with Boltzmann sampling',
      content: 'Free energy minimization for message routing.',
      timestamp: Date.now() - 3000,
    }));

    const allEngagements = [eng1, eng2, eng3];
    const arcs = store.detectArcs(allEngagements);

    // Should detect kuramoto-synchronization arc (eng1 + eng2 match kuramoto patterns)
    const kuramotoArc = arcs.find(a => a.topic === 'kuramoto-synchronization');
    expect(kuramotoArc).toBeDefined();
    expect(kuramotoArc!.engagements.length).toBeGreaterThanOrEqual(2);

    // Thermodynamic should NOT form an arc with only 1 engagement
    // (unless it also matches another pillar with enough volume)
  });

  it('detectArcs requires 2+ engagements for arc creation', () => {
    const eng1 = store.recordEngagement(makeEngagement({
      threadTitle: 'Moltyverse visualization of agent mesh',
      content: 'Observable 3D rendering of agents.',
      timestamp: Date.now() - 1000,
    }));

    const arcs = store.detectArcs([eng1]);
    // Only 1 engagement matching moltyverse — should not create arc
    const moltyverseArc = arcs.find(a => a.topic === 'moltyverse-visualization');
    expect(moltyverseArc).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────

  it('getSummary produces formatted context', () => {
    const eng = store.recordEngagement(makeEngagement({
      timestamp: Date.now() - 1000,
    }));
    store.updateOutcome(eng.id, { upvotes: 5, replies: 3, engagement: 0.8, measuredAt: Date.now() });

    const arc = store.getOrCreateArc('kuramoto-synchronization');
    store.linkEngagementToArc(eng.id, arc.id);
    arc.momentum = 0.5;

    const summary = store.getSummary();
    expect(summary).toContain('ACTIVE NARRATIVE ARCS');
    expect(summary).toContain('kuramoto-synchronization');
    expect(summary).toContain('RECENT ENGAGEMENTS');
    expect(summary).toContain('comment');
  });

  it('getSummary returns empty string when no data', () => {
    const summary = store.getSummary();
    expect(summary).toBe('');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SERIALIZATION
  // ──────────────────────────────────────────────────────────────────────────

  it('serialize/deserialize roundtrips', () => {
    const eng = store.recordEngagement(makeEngagement());
    store.updateOutcome(eng.id, { upvotes: 5, replies: 3, engagement: 0.8, measuredAt: Date.now() });
    const arc = store.getOrCreateArc('kuramoto-synchronization');
    store.linkEngagementToArc(eng.id, arc.id);

    const serialized = store.serialize();
    const restored = StrategicContextStore.deserialize(serialized);

    expect(restored.hasEngaged('thread-1')).toBe(true);
    expect(restored.getActiveArcs()).toHaveLength(1);
    expect(restored.getActiveArcs()[0].topic).toBe('kuramoto-synchronization');

    const history = restored.getThreadHistory('thread-1');
    expect(history).toHaveLength(1);
    expect(history[0].outcome?.upvotes).toBe(5);
  });

  it('deserialize handles invalid data gracefully', () => {
    const restored = StrategicContextStore.deserialize('not valid json');
    expect(restored.getActiveArcs()).toHaveLength(0);
    expect(restored.hasEngaged('anything')).toBe(false);
  });
});
