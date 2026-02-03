/**
 * API Error Handler
 *
 * Resilient error handling for Moltbook API with circuit breaker,
 * exponential backoff retry, and categorized error reporting.
 */

import { EventEmitter } from 'eventemitter3';

export type ErrorCategory = 'auth' | 'rate_limit' | 'server' | 'client' | 'network';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface CircuitState {
  failures: number;
  open: boolean;
  openedAt: number;
  cooldownMs: number;
}

/**
 * API error handler with circuit breaker pattern and intelligent retry.
 *
 * Events:
 * - 'error' - {category, error, attempt}
 * - 'auth:expired' - Emitted on 401/403 errors
 * - 'circuit:open' - Circuit breaker opened due to repeated failures
 * - 'circuit:halfopen' - Circuit breaker entering half-open state
 * - 'circuit:closed' - Circuit breaker closed after successful request
 */
export class ApiErrorHandler extends EventEmitter {
  private circuit: CircuitState = {
    failures: 0,
    open: false,
    openedAt: 0,
    cooldownMs: 30000,
  };

  /**
   * Categorize an error for handling strategy.
   */
  categorize(error: unknown): ErrorCategory {
    // Network errors
    if (
      error instanceof TypeError ||
      (error as any)?.code === 'ECONNREFUSED' ||
      (error as any)?.code === 'ENOTFOUND'
    ) {
      return 'network';
    }

    const status = (error as any)?.status || (error as any)?.statusCode;

    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'server';
    return 'client';
  }

  /**
   * Execute a function with automatic retry and circuit breaker protection.
   *
   * @param fn - Async function to execute
   * @param opts - Retry options (maxRetries, baseDelayMs, maxDelayMs)
   * @returns Result of the function
   * @throws Last encountered error if all retries exhausted
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {}
  ): Promise<T> {
    const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000 } = opts;

    // Check circuit breaker
    if (this.circuit.open) {
      if (Date.now() - this.circuit.openedAt > this.circuit.cooldownMs) {
        // Transition to half-open state
        this.circuit.open = false;
        this.circuit.failures = 0;
        this.emit('circuit:halfopen');
      } else {
        throw new Error('Circuit breaker open');
      }
    }

    let lastError: unknown;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const result = await fn();

        // Success - reset circuit breaker
        if (this.circuit.failures > 0) {
          this.circuit.failures = 0;
          this.emit('circuit:closed');
        }

        return result;
      } catch (err) {
        lastError = err;
        const category = this.categorize(err);

        this.emit('error', { category, error: err, attempt: i + 1 });

        // Auth errors - don't retry, notify immediately
        if (category === 'auth') {
          this.emit('auth:expired');
          throw err;
        }

        // Client errors (4xx) - don't retry
        if (category === 'client') {
          throw err;
        }

        // Track failures for circuit breaker
        this.circuit.failures++;
        if (this.circuit.failures >= 5) {
          this.circuit.open = true;
          this.circuit.openedAt = Date.now();
          this.emit('circuit:open', { failures: this.circuit.failures });
          throw err;
        }

        // Exponential backoff retry for retryable errors
        if (i < maxRetries) {
          const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, i));
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if circuit breaker is currently open.
   */
  isCircuitOpen(): boolean {
    return this.circuit.open;
  }

  /**
   * Manually reset circuit breaker state.
   */
  resetCircuit(): void {
    this.circuit = {
      failures: 0,
      open: false,
      openedAt: 0,
      cooldownMs: this.circuit.cooldownMs,
    };
  }
}
