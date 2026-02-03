import { describe, it, expect } from 'vitest';
import { KuramotoEngine, computeCoherence, evolvePhase, type Oscillator } from '../../src/resonance/kuramoto.js';
import { randomUUID as uuid } from 'crypto';
import type { Observer } from '../../src/primitives/types.js';

function makeObserver(id: string, frequency: number, phase: number): Observer {
  return {
    id,
    name: `observer-${id}`,
    frequency,
    layer: 0,
    collapseRate: 1,
    darkSensitivity: 0.5,
    phase,
  };
}

function makeOscillator(id: string, phase: number, freq = 1.0) {
  return {
    id,
    naturalFrequency: freq,
    phase,
    observer: makeObserver(id, freq, phase),
  };
}

describe('computeCoherence', () => {
  it('returns 1.0 for identical phases', () => {
    const oscs = [0, 0, 0, 0].map((p, i) => makeOscillator(`o${i}`, p));
    expect(computeCoherence(oscs)).toBeCloseTo(1.0, 2);
  });

  it('returns ~0 for uniformly distributed phases', () => {
    const N = 100;
    const oscs = Array.from({ length: N }, (_, i) =>
      makeOscillator(`o${i}`, (2 * Math.PI * i) / N)
    );
    expect(computeCoherence(oscs)).toBeCloseTo(0, 1);
  });

  it('returns intermediate value for partially aligned', () => {
    const oscs = [0, 0, Math.PI / 4, Math.PI / 4].map((p, i) =>
      makeOscillator(`o${i}`, p)
    );
    const r = computeCoherence(oscs);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(1.0);
  });

  it('returns 1.0 for single oscillator', () => {
    expect(computeCoherence([makeOscillator('a', 1.5)])).toBe(1);
  });

  it('returns 0 for empty array', () => {
    expect(computeCoherence([])).toBe(0);
  });
});

describe('KuramotoEngine', () => {
  it('increases coherence over ticks for spread phases', () => {
    const engine = new KuramotoEngine({ couplingStrength: 2.0, frequencyVariance: 0 });
    engine.addObserver(makeObserver(uuid(), 1.0, 0.0));
    engine.addObserver(makeObserver(uuid(), 1.0, 1.5));
    engine.addObserver(makeObserver(uuid(), 1.0, 3.0));

    const r0 = engine.getCoherence();
    for (let i = 0; i < 200; i++) engine.tick();
    const r1 = engine.getCoherence();
    expect(r1).toBeGreaterThanOrEqual(r0);
  });

  it('removes observers', () => {
    const engine = new KuramotoEngine();
    const id1 = uuid();
    const id2 = uuid();
    engine.addObserver(makeObserver(id1, 1.0, 0.0));
    engine.addObserver(makeObserver(id2, 1.0, 2.0));
    engine.removeObserver(id1);
    expect(engine.getCoherence()).toBeCloseTo(1.0, 2);
  });

  it('detects need for intervention at low coherence', () => {
    const engine = new KuramotoEngine({ coherenceThreshold: 0.9 });
    engine.addObserver(makeObserver(uuid(), 1.0, 0));
    engine.addObserver(makeObserver(uuid(), 1.0, Math.PI));
    expect(engine.needsIntervention()).toBe(true);
  });
});

describe('evolvePhase', () => {
  it('returns same phase for single oscillator', () => {
    const osc = makeOscillator('a', 1.0);
    const result = evolvePhase(osc, [osc], 1.0, 16);
    expect(result).toBe(1.0);
  });

  it('pulls phase toward other oscillators', () => {
    const a = makeOscillator('a', 0.0, 0); // phase=0, no natural freq
    const b = makeOscillator('b', 1.0, 0); // phase=1.0, no natural freq
    // Coupling should pull a toward b (positive direction)
    const newPhase = evolvePhase(a, [a, b], 2.0, 1000); // 1s step, strong coupling
    expect(newPhase).toBeGreaterThan(0.0);
  });

  it('wraps phase to [0, 2pi]', () => {
    // Large natural frequency + long dt should wrap
    const osc = makeOscillator('a', 0.0, 100); // freq=100 rad/s
    const result = evolvePhase(osc, [osc], 0, 1000); // 1s, no coupling
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(2 * Math.PI);
  });
});
