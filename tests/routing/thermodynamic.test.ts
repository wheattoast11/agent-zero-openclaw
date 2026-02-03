import { describe, it, expect } from 'vitest';
import { ThermodynamicRouter, computeEnergy, cosineSimilarity, softmax } from '../../src/routing/thermodynamic.js';
import { randomUUID as uuid } from 'crypto';
import type { Observer, Message } from '../../src/primitives/types.js';

function makeObserver(id: string): Observer {
  return {
    id,
    name: `obs-${id}`,
    frequency: 1.0,
    layer: 0,
    collapseRate: 1,
    darkSensitivity: 0.5,
    phase: 0,
  };
}

function makeMessage(embedding?: number[]): Message {
  return {
    id: uuid(),
    kind: 'think',
    from: uuid(),
    timestamp: Date.now(),
    payload: null,
    embedding,
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow('dimension mismatch');
  });
});

describe('softmax', () => {
  it('sums to 1', () => {
    const probs = softmax([1, 2, 3], 1.0);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 5);
  });

  it('lower energy gets higher probability', () => {
    const probs = softmax([0.1, 1.0], 1.0);
    expect(probs[0]).toBeGreaterThan(probs[1]);
  });
});

describe('ThermodynamicRouter', () => {
  it('routes to single available agent', () => {
    const router = new ThermodynamicRouter({ temperature: 1.0, annealingSchedule: 'none' });
    const obs = makeObserver(uuid());
    const msg = makeMessage(new Array(768).fill(0));
    const result = router.route(msg, [{
      observer: obs,
      load: 0,
      coherence: 1.0,
      attractor: new Array(768).fill(0),
    }]);
    expect(result.id).toBe(obs.id);
  });

  it('prefers low-energy agents at low temperature', () => {
    const router = new ThermodynamicRouter({ temperature: 0.01, annealingSchedule: 'none' });
    const closeObs = makeObserver(uuid());
    const farObs = makeObserver(uuid());
    // Use non-zero embeddings so cosine similarity is meaningful
    const embedding = new Array(768).fill(0).map((_, i) => (i % 2 === 0 ? 1 : 0));
    const closeAttractor = [...embedding]; // identical = max similarity
    const farAttractor = new Array(768).fill(0).map((_, i) => (i % 2 === 0 ? 0 : 1)); // orthogonal

    let closeCount = 0;
    for (let i = 0; i < 100; i++) {
      const msg = makeMessage(embedding);
      const result = router.route(msg, [
        { observer: closeObs, load: 0, coherence: 1.0, attractor: closeAttractor },
        { observer: farObs, load: 0, coherence: 1.0, attractor: farAttractor },
      ]);
      if (result.id === closeObs.id) closeCount++;
    }
    expect(closeCount).toBeGreaterThan(80);
  });

  it('temperature annealing reduces temperature', () => {
    const router = new ThermodynamicRouter({
      temperature: 10.0,
      annealingSchedule: 'exponential',
    });
    const t0 = router.getTemperature();
    // Route with 2+ agents triggers full path including anneal
    const obs1 = makeObserver(uuid());
    const obs2 = makeObserver(uuid());
    const attractor = new Array(768).fill(0).map((_, i) => (i < 384 ? 1 : 0));
    const msg = makeMessage(attractor);
    router.route(msg, [
      { observer: obs1, load: 0, coherence: 1.0, attractor },
      { observer: obs2, load: 0, coherence: 1.0, attractor },
    ]);
    expect(router.getTemperature()).toBeLessThan(t0);
  });
});
