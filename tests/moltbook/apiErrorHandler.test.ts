import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiErrorHandler, type ErrorCategory } from '../../src/moltbook/apiErrorHandler.js';

describe('ApiErrorHandler', () => {
  let handler: ApiErrorHandler;

  beforeEach(() => {
    handler = new ApiErrorHandler();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CATEGORIZE
  // ──────────────────────────────────────────────────────────────────────────

  describe('categorize', () => {
    it('categorizes TypeError as network', () => {
      expect(handler.categorize(new TypeError('fetch failed'))).toBe('network');
    });

    it('categorizes ECONNREFUSED as network', () => {
      const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      expect(handler.categorize(err)).toBe('network');
    });

    it('categorizes ENOTFOUND as network', () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      expect(handler.categorize(err)).toBe('network');
    });

    it('categorizes 401 as auth', () => {
      expect(handler.categorize({ status: 401 })).toBe('auth');
    });

    it('categorizes 403 as auth', () => {
      expect(handler.categorize({ status: 403 })).toBe('auth');
    });

    it('categorizes 429 as rate_limit', () => {
      expect(handler.categorize({ status: 429 })).toBe('rate_limit');
    });

    it('categorizes 500 as server', () => {
      expect(handler.categorize({ status: 500 })).toBe('server');
    });

    it('categorizes 503 as server', () => {
      expect(handler.categorize({ status: 503 })).toBe('server');
    });

    it('categorizes 400 as client', () => {
      expect(handler.categorize({ status: 400 })).toBe('client');
    });

    it('categorizes unknown errors as client', () => {
      expect(handler.categorize(new Error('unknown'))).toBe('client');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // EXECUTE WITH RETRY
  // ──────────────────────────────────────────────────────────────────────────

  describe('executeWithRetry', () => {
    it('returns result on success', async () => {
      const result = await handler.executeWithRetry(async () => 42);
      expect(result).toBe(42);
    });

    it('auth errors throw immediately without retry', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' });

      await expect(handler.executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 1 }))
        .rejects.toEqual({ status: 401, message: 'Unauthorized' });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('client errors throw immediately without retry', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 400, message: 'Bad request' });

      await expect(handler.executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 1 }))
        .rejects.toEqual({ status: 400, message: 'Bad request' });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('server errors retry with backoff', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce({ status: 500, message: 'Internal Server Error' })
        .mockRejectedValueOnce({ status: 502, message: 'Bad Gateway' })
        .mockResolvedValueOnce('success');

      const result = await handler.executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('emits error events on each failure', async () => {
      const errors: Array<{ category: ErrorCategory; attempt: number }> = [];
      handler.on('error', (e) => errors.push(e));

      const fn = vi.fn()
        .mockRejectedValueOnce({ status: 500 })
        .mockResolvedValueOnce('ok');

      await handler.executeWithRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0].category).toBe('server');
      expect(errors[0].attempt).toBe(1);
    });

    it('emits auth:expired on auth errors', async () => {
      const expired = vi.fn();
      handler.on('auth:expired', expired);

      const fn = vi.fn().mockRejectedValue({ status: 401 });
      await expect(handler.executeWithRetry(fn, { baseDelayMs: 1 })).rejects.toBeTruthy();
      expect(expired).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CIRCUIT BREAKER
  // ──────────────────────────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('opens after 5 consecutive failures', async () => {
      expect(handler.isCircuitOpen()).toBe(false);

      for (let i = 0; i < 5; i++) {
        try {
          await handler.executeWithRetry(
            async () => { throw { status: 500 }; },
            { maxRetries: 0, baseDelayMs: 1 }
          );
        } catch {
          // expected
        }
      }

      expect(handler.isCircuitOpen()).toBe(true);
    });

    it('rejects requests when circuit is open', async () => {
      // Force circuit open
      for (let i = 0; i < 5; i++) {
        try {
          await handler.executeWithRetry(
            async () => { throw { status: 500 }; },
            { maxRetries: 0, baseDelayMs: 1 }
          );
        } catch {
          // expected
        }
      }

      await expect(handler.executeWithRetry(async () => 'should not run', { baseDelayMs: 1 }))
        .rejects.toThrow('Circuit breaker open');
    });

    it('transitions to half-open after cooldown', async () => {
      const circuitHalfOpen = vi.fn();
      handler.on('circuit:halfopen', circuitHalfOpen);

      // Force circuit open
      for (let i = 0; i < 5; i++) {
        try {
          await handler.executeWithRetry(
            async () => { throw { status: 500 }; },
            { maxRetries: 0, baseDelayMs: 1 }
          );
        } catch {
          // expected
        }
      }

      expect(handler.isCircuitOpen()).toBe(true);

      // Manually set openedAt to past to simulate cooldown expiry
      // Access private state via any cast
      (handler as any).circuit.openedAt = Date.now() - 60000;

      const result = await handler.executeWithRetry(async () => 'recovered', { baseDelayMs: 1 });
      expect(result).toBe('recovered');
      expect(circuitHalfOpen).toHaveBeenCalled();
    });

    it('emits circuit:open event', async () => {
      const circuitOpen = vi.fn();
      handler.on('circuit:open', circuitOpen);

      for (let i = 0; i < 5; i++) {
        try {
          await handler.executeWithRetry(
            async () => { throw { status: 500 }; },
            { maxRetries: 0, baseDelayMs: 1 }
          );
        } catch {
          // expected
        }
      }

      expect(circuitOpen).toHaveBeenCalledWith({ failures: 5 });
    });

    it('emits circuit:closed on success after failures', async () => {
      const circuitClosed = vi.fn();
      handler.on('circuit:closed', circuitClosed);

      // One failure
      try {
        await handler.executeWithRetry(
          async () => { throw { status: 500 }; },
          { maxRetries: 0, baseDelayMs: 1 }
        );
      } catch {
        // expected
      }

      // Then success
      await handler.executeWithRetry(async () => 'ok', { baseDelayMs: 1 });
      expect(circuitClosed).toHaveBeenCalledTimes(1);
    });

    it('resetCircuit clears state', async () => {
      // Force some failures
      for (let i = 0; i < 5; i++) {
        try {
          await handler.executeWithRetry(
            async () => { throw { status: 500 }; },
            { maxRetries: 0, baseDelayMs: 1 }
          );
        } catch {
          // expected
        }
      }

      expect(handler.isCircuitOpen()).toBe(true);
      handler.resetCircuit();
      expect(handler.isCircuitOpen()).toBe(false);

      // Can execute again
      const result = await handler.executeWithRetry(async () => 'works', { baseDelayMs: 1 });
      expect(result).toBe('works');
    });
  });
});
