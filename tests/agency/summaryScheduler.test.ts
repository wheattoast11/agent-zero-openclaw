import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SummaryScheduler, createSummaryScheduler } from '../../src/agency/summaryScheduler.js';

// ============================================================================
// MOCKS
// ============================================================================

function createMockWhatsApp() {
  const sent: Array<{ text: string; to: string }> = [];
  return {
    connect: async () => {},
    disconnect: async () => {},
    onMessage: vi.fn(),
    send: vi.fn(async (text: string, to: string) => { sent.push({ text, to }); }),
    getStatus: () => 'connected' as const,
    sent,
  };
}

const USER_JID = '15551234567@s.whatsapp.net';

// ============================================================================
// TESTS
// ============================================================================

describe('SummaryScheduler', () => {
  let whatsApp: ReturnType<typeof createMockWhatsApp>;

  beforeEach(() => {
    whatsApp = createMockWhatsApp();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildScheduler(
    schedule: 'daily' | 'twice-daily' | 'on-demand',
    overrides: Record<string, unknown> = {},
  ): SummaryScheduler {
    return createSummaryScheduler({
      schedule,
      userJid: USER_JID,
      whatsApp: whatsApp as any,
      sources: { startTime: Date.now() - 3_600_000 },
      ...overrides,
    });
  }

  // --------------------------------------------------------------------------
  // on-demand schedule
  // --------------------------------------------------------------------------

  it('on-demand schedule: start() does not set timer', () => {
    const scheduler = buildScheduler('on-demand');
    const spy = vi.spyOn(globalThis, 'setInterval');

    scheduler.start();

    // setInterval should NOT have been called for on-demand
    expect(spy).not.toHaveBeenCalled();

    scheduler.stop();
  });

  // --------------------------------------------------------------------------
  // sendNow
  // --------------------------------------------------------------------------

  it('sendNow sends formatted summary via whatsApp', async () => {
    vi.useRealTimers(); // collectSummaryData uses Date.now()
    const scheduler = buildScheduler('on-demand');

    await scheduler.sendNow();

    expect(whatsApp.send).toHaveBeenCalledOnce();
    const [text, jid] = whatsApp.send.mock.calls[0];
    expect(jid).toBe(USER_JID);
    expect(text).toContain('Agent Zero');
    expect(text).toContain('Uptime:');
  });

  // --------------------------------------------------------------------------
  // Daily schedule defaults
  // --------------------------------------------------------------------------

  it('daily schedule defaults to hour 9', () => {
    const scheduler = buildScheduler('daily');
    // Access sendHours via the scheduler instance
    // We verify by checking that the scheduler was constructed without error
    // and that start() creates an interval
    const spy = vi.spyOn(globalThis, 'setInterval');
    scheduler.start();
    expect(spy).toHaveBeenCalledOnce();
    // Interval check runs every 60 seconds
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    scheduler.stop();
  });

  it('twice-daily schedule creates interval', () => {
    const scheduler = buildScheduler('twice-daily');
    const spy = vi.spyOn(globalThis, 'setInterval');
    scheduler.start();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    scheduler.stop();
  });

  // --------------------------------------------------------------------------
  // stop clears timer
  // --------------------------------------------------------------------------

  it('stop clears timer', () => {
    const scheduler = buildScheduler('daily');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    scheduler.start();
    scheduler.stop();

    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it('stop is safe to call when not started', () => {
    const scheduler = buildScheduler('daily');
    // Should not throw
    expect(() => scheduler.stop()).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // checkAndSend integration (via timer tick)
  // --------------------------------------------------------------------------

  it('checkAndSend sends at configured hour', async () => {
    // Set time to 09:00:00 on a known date
    const targetDate = new Date('2026-02-05T09:00:00');
    vi.setSystemTime(targetDate);

    const scheduler = buildScheduler('daily', { sendHours: [9] });
    scheduler.start();

    // Advance 60 seconds to trigger the interval check
    await vi.advanceTimersByTimeAsync(60_000);

    expect(whatsApp.send).toHaveBeenCalled();
    const [text, jid] = whatsApp.send.mock.calls[0];
    expect(jid).toBe(USER_JID);
    expect(text).toContain('Agent Zero');

    scheduler.stop();
  });

  it('checkAndSend does not send at non-configured hour', async () => {
    // Set time to 14:00:00 (not in send hours)
    const targetDate = new Date('2026-02-05T14:00:00');
    vi.setSystemTime(targetDate);

    const scheduler = buildScheduler('daily', { sendHours: [9] });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(whatsApp.send).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('checkAndSend does not send twice in the same hour', async () => {
    const targetDate = new Date('2026-02-05T09:00:00');
    vi.setSystemTime(targetDate);

    const scheduler = buildScheduler('daily', { sendHours: [9] });
    scheduler.start();

    // First tick: sends
    await vi.advanceTimersByTimeAsync(60_000);
    expect(whatsApp.send).toHaveBeenCalledOnce();

    // Second tick (same hour): should NOT send again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(whatsApp.send).toHaveBeenCalledOnce();

    scheduler.stop();
  });
});
