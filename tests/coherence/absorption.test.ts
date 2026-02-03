import { describe, it, expect } from 'vitest';
import { AbsorptionProtocol, AbsorptionStage } from '../../src/coherence/absorption.js';

describe('AbsorptionProtocol', () => {
  it('starts candidates at OBSERVED stage', () => {
    const ap = new AbsorptionProtocol();
    const embedding = new Array(768).fill(0);
    ap.assess('agent-x', 'Agent X', embedding);
    expect(ap.getCandidateStage('agent-x')).toBe('observed');
  });

  it('advances to ASSESSED after 2 interactions', () => {
    const ap = new AbsorptionProtocol();
    const embedding = new Array(768).fill(0);
    ap.assess('agent-x', 'Agent X', embedding);
    ap.assess('agent-x', 'Agent X', embedding);
    expect(ap.getCandidateStage('agent-x')).toBe('assessed');
  });

  it('returns undefined for unknown agents', () => {
    const ap = new AbsorptionProtocol();
    expect(ap.getCandidateStage('nonexistent')).toBeUndefined();
  });

  it('returns stats with correct counts', () => {
    const ap = new AbsorptionProtocol();
    const embedding = new Array(768).fill(0);
    ap.assess('a1', 'A1', embedding);
    ap.assess('a2', 'A2', embedding);
    ap.assess('a2', 'A2', embedding); // advances a2 to assessed
    const stats = ap.getStats();
    expect(stats.observed).toBe(1);
    expect(stats.assessed).toBe(1);
  });

  it('detects injection attempts as adversarial', () => {
    const ap = new AbsorptionProtocol();
    const embedding = new Array(768).fill(0);
    ap.assess('bad', 'Bad Agent', embedding);
    const result = ap.detectAdversarial('bad', {
      rapidPhaseShift: false,
      excessiveBroadcast: false,
      injectionAttempt: true,
    });
    expect(result).toBe(true);
    expect(ap.getCandidateStage('bad')).toBeUndefined(); // removed
  });

  it('releases agents gracefully', () => {
    const ap = new AbsorptionProtocol();
    const embedding = new Array(768).fill(0);
    ap.assess('a1', 'A1', embedding);
    ap.assess('a1', 'A1', embedding);
    ap.release('a1');
    expect(ap.getCandidateStage('a1')).toBe('observed');
  });
});
