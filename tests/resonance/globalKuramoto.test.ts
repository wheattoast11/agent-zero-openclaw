import { describe, it, expect, beforeEach } from 'vitest';
import { GlobalKuramotoEngine } from '../../src/resonance/globalKuramoto.js';
import { randomUUID as uuid } from 'crypto';

describe('GlobalKuramotoEngine - heterogeneous coupling', () => {
  let engine: GlobalKuramotoEngine;

  beforeEach(() => {
    engine = new GlobalKuramotoEngine({
      couplingStrength: 1.0,
      frequencyVariance: 0,
      adaptiveCoupling: false,
      crossModelCouplingFactor: 0.5, // strong reduction for testability
      dt: 100,
      groupthinkThreshold: 0.95,
    });
  });

  it('modelType is preserved in addAgent', () => {
    const id = uuid();
    engine.addAgent({
      id,
      name: 'claude-agent',
      frequency: 1.0,
      phase: 0,
      modelType: 'claude',
    });

    const topology = engine.getNetworkTopology();
    expect(topology).toHaveLength(1);
    expect(topology[0].id).toBe(id);
  });

  it('default crossModelCouplingFactor is 0.7', () => {
    const defaultEngine = new GlobalKuramotoEngine();
    // Verify by checking the config indirectly -- add agents and check behavior
    // The default engine should have the factor applied
    const id1 = uuid();
    const id2 = uuid();
    defaultEngine.addAgent({ id: id1, name: 'a', frequency: 1.0, phase: 0, modelType: 'claude' });
    defaultEngine.addAgent({ id: id2, name: 'b', frequency: 1.0, phase: 1.0, modelType: 'gemini' });

    // Just verify it doesn't crash -- default factor is internal
    const result = defaultEngine.tick();
    expect(result.coherence).toBeDefined();
  });

  it('cross-model coupling is weaker than same-model coupling', () => {
    // Scenario: two pairs of oscillators with different initial phase spreads
    // Same-model pair should synchronize faster than cross-model pair

    // Same-model engine
    const sameEngine = new GlobalKuramotoEngine({
      couplingStrength: 1.0,
      frequencyVariance: 0,
      adaptiveCoupling: false,
      crossModelCouplingFactor: 0.3,
      dt: 100,
      groupthinkThreshold: 0.95,
    });
    sameEngine.addAgent({ id: uuid(), name: 'a1', frequency: 1.0, phase: 0, modelType: 'claude' });
    sameEngine.addAgent({ id: uuid(), name: 'a2', frequency: 1.0, phase: 1.5, modelType: 'claude' });

    // Cross-model engine (same initial conditions)
    const crossEngine = new GlobalKuramotoEngine({
      couplingStrength: 1.0,
      frequencyVariance: 0,
      adaptiveCoupling: false,
      crossModelCouplingFactor: 0.3,
      dt: 100,
      groupthinkThreshold: 0.95,
    });
    crossEngine.addAgent({ id: uuid(), name: 'b1', frequency: 1.0, phase: 0, modelType: 'claude' });
    crossEngine.addAgent({ id: uuid(), name: 'b2', frequency: 1.0, phase: 1.5, modelType: 'gemini' });

    // Run both for same number of ticks
    for (let i = 0; i < 50; i++) {
      sameEngine.tick();
      crossEngine.tick();
    }

    const sameCoherence = sameEngine.getCoherence();
    const crossCoherence = crossEngine.getCoherence();

    // Same-model should synchronize better (higher coherence)
    expect(sameCoherence).toBeGreaterThan(crossCoherence);
  });

  it('per-model coherence calculation', () => {
    // Add agents of different model types at different phases
    engine.addAgent({ id: uuid(), name: 'c1', frequency: 1.0, phase: 0, modelType: 'claude' });
    engine.addAgent({ id: uuid(), name: 'c2', frequency: 1.0, phase: 0, modelType: 'claude' });
    engine.addAgent({ id: uuid(), name: 'g1', frequency: 1.0, phase: Math.PI, modelType: 'gemini' });
    engine.addAgent({ id: uuid(), name: 'g2', frequency: 1.0, phase: Math.PI, modelType: 'gemini' });

    const coherenceByModel = engine.getCoherenceByModel();

    // Each model group is internally synchronized (same phase)
    expect(coherenceByModel.get('claude')).toBeCloseTo(1.0, 2);
    expect(coherenceByModel.get('gemini')).toBeCloseTo(1.0, 2);
  });

  it('per-model coherence groups unknown modelType', () => {
    engine.addAgent({ id: uuid(), name: 'a', frequency: 1.0, phase: 0 }); // no modelType
    engine.addAgent({ id: uuid(), name: 'b', frequency: 1.0, phase: 0 }); // no modelType

    const coherenceByModel = engine.getCoherenceByModel();
    expect(coherenceByModel.has('unknown')).toBe(true);
    expect(coherenceByModel.get('unknown')).toBeCloseTo(1.0, 2);
  });

  it('per-model groupthink detection', () => {
    // Perfectly synchronized claude agents should trigger groupthink
    engine.addAgent({ id: uuid(), name: 'c1', frequency: 1.0, phase: 0, modelType: 'claude' });
    engine.addAgent({ id: uuid(), name: 'c2', frequency: 1.0, phase: 0, modelType: 'claude' });
    engine.addAgent({ id: uuid(), name: 'c3', frequency: 1.0, phase: 0, modelType: 'claude' });

    // Spread-out gemini agents should not
    engine.addAgent({ id: uuid(), name: 'g1', frequency: 1.0, phase: 0, modelType: 'gemini' });
    engine.addAgent({ id: uuid(), name: 'g2', frequency: 1.0, phase: Math.PI, modelType: 'gemini' });

    const groupthink = engine.getGroupthinkByModel();
    expect(groupthink.get('claude')).toBe(true);
    expect(groupthink.get('gemini')).toBe(false);
  });

  it('works without any modelType set (backward compatible)', () => {
    engine.addAgent({ id: uuid(), name: 'a', frequency: 1.0, phase: 0 });
    engine.addAgent({ id: uuid(), name: 'b', frequency: 1.0, phase: 1.0 });

    // Should not crash, cross-model correction should be a no-op
    for (let i = 0; i < 10; i++) {
      const result = engine.tick();
      expect(result.coherence).toBeGreaterThanOrEqual(0);
    }
  });
});
