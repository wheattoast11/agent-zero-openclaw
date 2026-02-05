import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandRouter, createCommandRouter } from '../../src/agency/commandRouter.js';
import type { Message } from '../../src/primitives/types.js';
import { randomUUID } from 'crypto';

// ============================================================================
// MOCKS
// ============================================================================

function createMockWhatsApp() {
  let handler: ((msg: Message) => void) | null = null;
  const sent: Array<{ text: string; to: string }> = [];
  return {
    connect: async () => {},
    disconnect: async () => {},
    onMessage: (h: (msg: Message) => void) => { handler = h; },
    send: async (text: string, to: string) => { sent.push({ text, to }); },
    getStatus: () => 'connected' as const,
    simulateMessage: (msg: Message) => handler?.(msg),
    sent,
  };
}

function createMockSms() {
  let handler: ((msg: Message) => void) | null = null;
  const sent: Array<{ text: string; to: string }> = [];
  return {
    connect: async () => {},
    disconnect: async () => {},
    onMessage: (h: (msg: Message) => void) => { handler = h; },
    send: async (text: string, to: string) => { sent.push({ text, to }); },
    getStatus: () => 'connected' as const,
    simulateMessage: (msg: Message) => handler?.(msg),
    sent,
  };
}

function createMockDaemon(overrides?: Partial<ReturnType<typeof createMockDaemon>>) {
  return {
    getStatus: () => ({
      running: true,
      mode: 'supervised' as const,
      engagedThreads: 5,
      totals: { polled: 100, scored: 100, composed: 10, approved: 5, posted: 5, queued: 3, skipped: 80, bait: 2, errors: 0 },
      attention: { scored: 100, engaged: 5, skipped: 80, baitDetected: 2 },
      composer: { composed: 10, skipped: 0, failed: 0 },
      gate: { approved: 5, queued: 3, rejected: 0, mode: 'supervised' as const },
    }),
    getGate: () => ({
      listPending: async () => [] as any[],
    }),
    toggleMode: async () => 'autonomous' as const,
    getMode: () => 'supervised' as const,
    ...overrides,
  };
}

function createMockScheduler() {
  return {
    sendNow: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function makeMsg(content: string, remoteJid: string, platform?: string): Message {
  return {
    id: randomUUID(),
    kind: 'percept',
    from: randomUUID(),
    payload: { remoteJid, content, ...(platform ? { platform } : {}) },
    timestamp: Date.now(),
  };
}

const USER_JID = '15551234567@s.whatsapp.net';
const USER_PHONE = '+15551234567';

// ============================================================================
// TESTS
// ============================================================================

describe('CommandRouter', () => {
  let whatsApp: ReturnType<typeof createMockWhatsApp>;
  let router: CommandRouter;

  beforeEach(() => {
    whatsApp = createMockWhatsApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildRouter(overrides: Record<string, unknown> = {}): CommandRouter {
    const config = {
      userJid: USER_JID,
      whatsApp: whatsApp as any,
      startTime: Date.now() - 3_600_000, // 1 hour ago
      ...overrides,
    };
    const r = createCommandRouter(config as any);
    r.attach();
    return r;
  }

  // --------------------------------------------------------------------------
  // Security: ignore non-user messages
  // --------------------------------------------------------------------------

  it('ignores messages from non-user JID', async () => {
    router = buildRouter();
    const msg = makeMsg('/status', 'other@s.whatsapp.net');
    whatsApp.simulateMessage(msg);
    // Give async handler time to run
    await vi.waitFor(() => {
      // No reply should have been sent
      expect(whatsApp.sent).toHaveLength(0);
    });
  });

  it('ignores messages with no remoteJid', async () => {
    router = buildRouter();
    const msg: Message = {
      id: randomUUID(),
      kind: 'percept',
      from: randomUUID(),
      payload: { content: '/status' },
      timestamp: Date.now(),
    };
    whatsApp.simulateMessage(msg);
    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(0);
    });
  });

  it('ignores empty text messages', async () => {
    router = buildRouter();
    const msg = makeMsg('', USER_JID);
    whatsApp.simulateMessage(msg);
    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // /status
  // --------------------------------------------------------------------------

  it('/status returns uptime and WhatsApp status', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/status', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Agent Zero Status');
    expect(reply).toContain('Uptime:');
    expect(reply).toContain('1h 0m');
    expect(reply).toContain('WhatsApp: connected');
  });

  it('/status includes moltbook stats when daemon provided', async () => {
    const daemon = createMockDaemon();
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/status', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Moltbook: running (supervised)');
    expect(reply).toContain('Posted: 5');
    expect(reply).toContain('Queued: 3');
  });

  // --------------------------------------------------------------------------
  // /summary
  // --------------------------------------------------------------------------

  it('/summary calls summaryScheduler.sendNow()', async () => {
    const scheduler = createMockScheduler();
    router = buildRouter({ summaryScheduler: scheduler });
    whatsApp.simulateMessage(makeMsg('/summary', USER_JID));

    await vi.waitFor(() => {
      expect(scheduler.sendNow).toHaveBeenCalledOnce();
    });
  });

  it('/summary without scheduler sends not-configured message', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/summary', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('Summary scheduler not configured');
  });

  // --------------------------------------------------------------------------
  // /toggle
  // --------------------------------------------------------------------------

  it('/toggle calls moltbookDaemon.toggleMode()', async () => {
    const daemon = createMockDaemon();
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/toggle', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('autonomous');
  });

  it('/toggle without daemon sends not-running message', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/toggle', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('Moltbook daemon not running');
  });

  // --------------------------------------------------------------------------
  // /review
  // --------------------------------------------------------------------------

  it('/review shows pending items', async () => {
    const daemon = createMockDaemon({
      getGate: () => ({
        listPending: async () => [
          {
            id: 'abcd1234-5678-9abc-def0-123456789abc',
            response: { threadId: 't1', content: 'This is a test response', confidence: 0.85, reasoning: 'test', action: 'comment' },
            queuedAt: new Date().toISOString(),
            status: 'pending' as const,
          },
        ],
      }),
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/review', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('1 pending review');
    expect(reply).toContain('abcd1234');
    expect(reply).toContain('comment');
    expect(reply).toContain('85%');
  });

  it('/review shows "No pending items" when empty', async () => {
    const daemon = createMockDaemon();
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/review', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('No pending items');
  });

  // --------------------------------------------------------------------------
  // /moltbook
  // --------------------------------------------------------------------------

  it('/moltbook shows engagement stats', async () => {
    const daemon = createMockDaemon();
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/moltbook', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Moltbook Engagement Stats');
    expect(reply).toContain('Mode: supervised');
    expect(reply).toContain('Engaged threads: 5');
    expect(reply).toContain('Polled: 100');
    expect(reply).toContain('Composed: 10');
    expect(reply).toContain('Posted: 5');
    expect(reply).toContain('Queued: 3');
    expect(reply).toContain('Bait detected: 2');
    expect(reply).toContain('Errors: 0');
  });

  // --------------------------------------------------------------------------
  // /help
  // --------------------------------------------------------------------------

  it('/help lists all commands', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/help', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('/status');
    expect(reply).toContain('/summary');
    expect(reply).toContain('/toggle');
    expect(reply).toContain('/review');
    expect(reply).toContain('/moltbook');
    expect(reply).toContain('/help');
  });

  // --------------------------------------------------------------------------
  // Unknown command
  // --------------------------------------------------------------------------

  it('unknown command returns error message', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/bogus', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Unknown command: /bogus');
    expect(reply).toContain('/help');
  });

  // --------------------------------------------------------------------------
  // Freetext -> LLM
  // --------------------------------------------------------------------------

  it('freetext calls OpenRouter API and relays response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'LLM says hello' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    router = buildRouter({ llmApiKey: 'test-key', llmModel: 'test/model' });
    whatsApp.simulateMessage(makeMsg('what is agent zero?', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    expect(whatsApp.sent[0].text).toBe('LLM says hello');

    // Verify fetch was called with correct params
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('test/model');
    expect(body.messages[1].content).toBe('what is agent zero?');

    vi.unstubAllGlobals();
  });

  it('freetext without llmApiKey sends not-configured message', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('hello there', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('LLM not configured');
  });

  it('freetext handles fetch failure gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal('fetch', mockFetch);

    router = buildRouter({ llmApiKey: 'test-key' });
    whatsApp.simulateMessage(makeMsg('hello', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toBe('LLM request failed.');

    vi.unstubAllGlobals();
  });

  // --------------------------------------------------------------------------
  // SMS routing
  // --------------------------------------------------------------------------

  it('SMS routing: matches against userPhone, replies via SMS', async () => {
    const sms = createMockSms();
    router = buildRouter({ sms: sms as any, userPhone: USER_PHONE });

    const msg = makeMsg('/status', USER_PHONE, 'sms');
    sms.simulateMessage(msg);

    await vi.waitFor(() => {
      expect(sms.sent).toHaveLength(1);
    });

    expect(sms.sent[0].to).toBe(USER_PHONE);
    expect(sms.sent[0].text).toContain('Agent Zero Status');
    // WhatsApp should NOT have received a reply
    expect(whatsApp.sent).toHaveLength(0);
  });

  it('SMS ignores messages from non-user phone', async () => {
    const sms = createMockSms();
    router = buildRouter({ sms: sms as any, userPhone: USER_PHONE });

    const msg = makeMsg('/status', '+19999999999', 'sms');
    sms.simulateMessage(msg);

    await vi.waitFor(() => {
      expect(sms.sent).toHaveLength(0);
      expect(whatsApp.sent).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  it('error in command handler sends error reply', async () => {
    const daemon = createMockDaemon({
      getGate: () => ({
        listPending: async () => { throw new Error('gate exploded'); },
      }),
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/review', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('Error: gate exploded');
  });
});
