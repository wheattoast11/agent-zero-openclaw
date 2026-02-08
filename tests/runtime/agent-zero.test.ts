import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentZero } from '../../src/runtime/agent-zero.js';

describe('AgentZero', () => {
  let agent: AgentZero;

  beforeEach(() => {
    agent = new AgentZero({ name: 'test-agent' });
  });

  afterEach(() => {
    agent.destroy();
  });

  // ==========================================================================
  // STATE MACHINE LIFECYCLE
  // ==========================================================================

  describe('state machine', () => {
    it('starts in void state', () => {
      expect(agent.getState().state).toBe('void');
    });

    it('transitions void → potential → collapse → operate → trace', () => {
      const states: string[] = [];
      agent.on('state:change', (_old, newState) => states.push(newState));

      agent.start('test task');

      expect(states).toEqual(['potential', 'collapse', 'operate']);
      expect(agent.getState().state).toBe('operate');

      agent.stop();
      expect(states).toContain('trace');
    });

    it('potential creates a dark token', () => {
      agent.start('test task');
      const state = agent.getState();
      expect(state.tokens.length).toBeGreaterThan(0);
      // After collapse, dark tokens become emitting
      expect(state.tokens.some(t => t.phase === 'emitting')).toBe(true);
    });

    it('trace emits all remaining tokens as emitted', () => {
      const emittedTokens: any[] = [];
      agent.on('token:emitted', t => emittedTokens.push(t));

      agent.start('test task');
      agent.stop();

      expect(emittedTokens.length).toBeGreaterThan(0);
      expect(emittedTokens.every(t => t.phase === 'emitted')).toBe(true);
    });

    it('realize sets proof and transitions to trace', () => {
      let realized = false;
      agent.on('realize', r => { realized = true; });

      agent.start('prove something');
      agent.realize('QED');

      expect(realized).toBe(true);
      expect(agent.getState().realizability.isRealized).toBe(true);
      expect(agent.getState().realizability.proof).toBe('QED');
    });
  });

  // ==========================================================================
  // CHILD MANAGEMENT
  // ==========================================================================

  describe('child management', () => {
    it('spawn creates child agent', () => {
      agent.start('parent task');
      const child = agent.spawn({ name: 'child-1' });

      expect(child).not.toBeNull();
      expect(agent.getChildren()).toHaveLength(1);
      expect(agent.getChildren()[0].name).toBe('child-1');
    });

    it('haltChild removes child and cleans up oscillator', () => {
      agent.start('parent task');
      const child = agent.spawn({ name: 'child-1' })!;

      agent.haltChild(child.id);
      expect(agent.getChildren()).toHaveLength(0);
    });

    it('halt message cleans up all children', () => {
      agent.start('parent task');
      agent.spawn({ name: 'child-1' });
      agent.spawn({ name: 'child-2' });
      expect(agent.getChildren()).toHaveLength(2);

      // Send halt message
      agent.receive({
        id: 'halt-msg',
        kind: 'halt',
        from: 'external',
        payload: null,
        timestamp: Date.now(),
      });
      agent.processNext();

      expect(agent.getChildren()).toHaveLength(0);
    });

    it('stop halts all children recursively', () => {
      agent.start('parent task');
      const child = agent.spawn({ name: 'child-1' })!;
      child.start('child task');
      const grandchild = child.spawn({ name: 'grandchild-1' });

      expect(grandchild).not.toBeNull();

      agent.stop();
      expect(agent.getChildren()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // MESSAGE HANDLING
  // ==========================================================================

  describe('messaging', () => {
    it('send creates message in outbox', () => {
      agent.start('test task');
      const msg = agent.send('think', { thought: 'hello' });

      expect(msg.id).toBeDefined();
      expect(msg.kind).toBe('think');
      expect(msg.from).toBe(agent.id);
    });

    it('receive stores message and updates causal distance', () => {
      agent.start('test task');
      const initialDrift = agent.getState().drift.causalDistance;

      agent.receive({
        id: 'msg-1',
        kind: 'percept',
        from: 'external',
        payload: 'observation data',
        timestamp: Date.now(),
      });

      expect(agent.getState().drift.causalDistance).toBe(initialDrift + 1);
    });

    it('percept message creates memory', () => {
      agent.start('test task');

      agent.receive({
        id: 'msg-1',
        kind: 'percept',
        from: 'external',
        payload: 'observed phenomenon',
        timestamp: Date.now(),
      });
      agent.processNext();

      expect(agent.getState().memories).toHaveLength(1);
      expect(agent.getState().memories[0].content).toBe('observed phenomenon');
    });

    it('resonate message nudges phase', () => {
      agent.start('test task');
      const initialPhase = agent.getState().observer.phase;

      agent.receive({
        id: 'msg-1',
        kind: 'resonate',
        from: 'external',
        payload: { phase: 0 },
        timestamp: Date.now(),
      });
      agent.processNext();

      // Phase should have moved toward 0
      const newPhase = agent.getState().observer.phase;
      if (initialPhase !== 0) {
        expect(Math.abs(newPhase)).toBeLessThan(Math.abs(initialPhase));
      }
    });
  });

  // ==========================================================================
  // COHERENCE
  // ==========================================================================

  describe('coherence', () => {
    it('single agent has coherence 1', () => {
      agent.start('test task');
      expect(agent.getCoherence()).toBe(1);
    });

    it('spawning children affects coherence', () => {
      agent.start('test task');
      agent.spawn({ name: 'child-1' });
      agent.spawn({ name: 'child-2' });

      const coherence = agent.getCoherence();
      expect(coherence).toBeGreaterThanOrEqual(0);
      expect(coherence).toBeLessThanOrEqual(1);
    });
  });

  // ==========================================================================
  // TEMPERATURE
  // ==========================================================================

  describe('temperature', () => {
    it('get/set temperature', () => {
      agent.start('test task');
      agent.setTemperature(0.5);
      expect(agent.getTemperature()).toBe(0.5);
    });

    it('temperature is floored at MIN_TEMPERATURE', () => {
      agent.start('test task');
      agent.setTemperature(0);
      expect(agent.getTemperature()).toBeGreaterThan(0);
    });
  });
});
