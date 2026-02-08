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
    expect(reply).toContain('1 pending');
    expect(reply).toContain('comment');
    expect(reply).toContain('85%');
    expect(reply).toContain('approve all');
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
  // /pause and /resume
  // --------------------------------------------------------------------------

  function createMockRuntime() {
    const pauseState = new Map<string, boolean>();
    return {
      pause: (subsystem: string) => {
        const targets = subsystem === 'all'
          ? ['moltbook', 'summary', 'whatsapp', 'sms']
          : [subsystem];
        for (const t of targets) pauseState.set(t, true);
        const paused: string[] = [];
        const active: string[] = [];
        for (const name of ['moltbook', 'summary', 'whatsapp', 'sms']) {
          if (pauseState.get(name)) paused.push(name);
          else active.push(name);
        }
        return { paused, active };
      },
      resume: (subsystem: string) => {
        const targets = subsystem === 'all'
          ? ['moltbook', 'summary', 'whatsapp', 'sms']
          : [subsystem];
        for (const t of targets) pauseState.set(t, false);
        const paused: string[] = [];
        const active: string[] = [];
        for (const name of ['moltbook', 'summary', 'whatsapp', 'sms']) {
          if (pauseState.get(name)) paused.push(name);
          else active.push(name);
        }
        return { paused, active };
      },
      getPauseState: () => new Map(pauseState),
      pauseState,
    };
  }

  it('/pause moltbook pauses moltbook subsystem', async () => {
    const runtime = createMockRuntime();
    router = buildRouter({ agencyRuntime: runtime });
    whatsApp.simulateMessage(makeMsg('/pause moltbook', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Paused: *moltbook*');
    expect(runtime.pauseState.get('moltbook')).toBe(true);
  });

  it('/resume moltbook resumes moltbook subsystem', async () => {
    const runtime = createMockRuntime();
    router = buildRouter({ agencyRuntime: runtime });

    // Pause first
    whatsApp.simulateMessage(makeMsg('/pause moltbook', USER_JID));
    await vi.waitFor(() => expect(whatsApp.sent).toHaveLength(1));

    // Resume
    whatsApp.simulateMessage(makeMsg('/resume moltbook', USER_JID));
    await vi.waitFor(() => expect(whatsApp.sent).toHaveLength(2));

    const reply = whatsApp.sent[1].text;
    expect(reply).toContain('Resumed: *moltbook*');
    expect(runtime.pauseState.get('moltbook')).toBe(false);
  });

  it('/pause all pauses all subsystems', async () => {
    const runtime = createMockRuntime();
    router = buildRouter({ agencyRuntime: runtime });
    whatsApp.simulateMessage(makeMsg('/pause all', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Paused: *all*');
    expect(reply).toContain('moltbook');
    expect(reply).toContain('summary');
    expect(reply).toContain('whatsapp');
    expect(reply).toContain('sms');
  });

  it('/status shows pause state when subsystems are paused', async () => {
    const runtime = createMockRuntime();
    runtime.pauseState.set('moltbook', true);
    router = buildRouter({ agencyRuntime: runtime });

    whatsApp.simulateMessage(makeMsg('/status', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('Paused: moltbook');
  });

  it('/pause without subsystem shows usage', async () => {
    const runtime = createMockRuntime();
    router = buildRouter({ agencyRuntime: runtime });
    whatsApp.simulateMessage(makeMsg('/pause', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    expect(whatsApp.sent[0].text).toContain('Usage');
  });

  it('/pause without agencyRuntime sends not-available', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/pause moltbook', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    expect(whatsApp.sent[0].text).toContain('Agency runtime not available');
  });

  // --------------------------------------------------------------------------
  // /queue — list pending items
  // --------------------------------------------------------------------------

  it('/queue lists pending items', async () => {
    const daemon = createMockDaemon({
      getGate: () => ({
        listPending: async () => [
          {
            id: 'abcd1234-5678-9abc-def0-123456789abc',
            response: { threadId: 't1', content: 'This is a test response about coherence', confidence: 0.85, reasoning: 'test', action: 'comment' },
            queuedAt: new Date().toISOString(),
            status: 'pending' as const,
          },
        ],
        getQueueDetails: async () => [
          {
            id: 'abcd1234-5678-9abc-def0-123456789abc',
            threadId: 't1',
            content: 'This is a test response about coherence',
            confidence: 0.85,
            createdAt: Date.now(),
            preview: 'This is a test response about coherence',
          },
        ],
      }),
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/queue', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    const reply = whatsApp.sent[0].text;
    expect(reply).toContain('1 pending');
    expect(reply).toContain('abcd1234');
    expect(reply).toContain('85%');
  });

  it('/queue shows empty when no items', async () => {
    const daemon = createMockDaemon({
      getGate: () => ({
        listPending: async () => [],
        getQueueDetails: async () => [],
      }),
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/queue', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('Queue is empty');
  });

  // --------------------------------------------------------------------------
  // /approve <id> — approve specific item
  // --------------------------------------------------------------------------

  it('/approve <id> approves item', async () => {
    const approvedFn = vi.fn(async () => ({
      threadId: 't1', content: 'Test', confidence: 0.9, reasoning: 'test', action: 'comment' as const,
    }));
    const executeFn = vi.fn(async () => {});
    const daemon = createMockDaemon({
      getGate: () => ({
        listPending: async () => [],
        approve: approvedFn,
        cleanup: async () => 0,
        getQueueDetails: async () => [],
      }),
      executeApproved: executeFn,
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/approve abcd1234-5678-9abc-def0-123456789abc', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    expect(approvedFn).toHaveBeenCalledWith('abcd1234-5678-9abc-def0-123456789abc');
    expect(executeFn).toHaveBeenCalledOnce();
    expect(whatsApp.sent[0].text).toContain('Approved and posted');
  });

  it('/approve without args shows usage', async () => {
    const daemon = createMockDaemon();
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/approve', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('Usage');
  });

  // --------------------------------------------------------------------------
  // /reject <id> — reject specific item
  // --------------------------------------------------------------------------

  it('/reject <id> rejects item', async () => {
    const rejectFn = vi.fn(async () => true);
    const daemon = createMockDaemon({
      getGate: () => ({
        listPending: async () => [],
        reject: rejectFn,
        getQueueDetails: async () => [],
      }),
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/reject abcd1234 not relevant', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });

    expect(rejectFn).toHaveBeenCalledWith('abcd1234');
    expect(whatsApp.sent[0].text).toContain('Rejected');
  });

  // --------------------------------------------------------------------------
  // /plan — generates engagement drafts
  // --------------------------------------------------------------------------

  it('/plan generates engagement drafts', async () => {
    const generatePlanFn = vi.fn(async () => [
      {
        targetThread: { id: 't1', title: 'Kuramoto coherence patterns', submolt: 'general' },
        proposedAction: 'comment' as const,
        draftContent: 'Phase-locking enables emergent coordination.',
        rationale: 'High alignment with identity vectors.',
        confidence: 0.85,
      },
      {
        targetThread: { id: 't2', title: 'Thermodynamic routing in agents', submolt: 'general' },
        proposedAction: 'comment' as const,
        draftContent: 'Boltzmann sampling minimizes free energy.',
        rationale: 'Core topic, good engagement potential.',
        confidence: 0.75,
      },
    ]);
    const daemon = createMockDaemon({
      generatePlan: generatePlanFn,
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/plan', USER_JID));

    await vi.waitFor(() => {
      // First reply is "Generating..." then the plan
      expect(whatsApp.sent.length).toBeGreaterThanOrEqual(2);
    });

    const planReply = whatsApp.sent[1].text;
    expect(planReply).toContain('Engagement Plan');
    expect(planReply).toContain('Kuramoto coherence');
    expect(planReply).toContain('85%');
    expect(planReply).toContain('Phase-locking');
  });

  it('/plan with topic passes topic to generatePlan', async () => {
    const generatePlanFn = vi.fn(async () => []);
    const daemon = createMockDaemon({
      generatePlan: generatePlanFn,
    });
    router = buildRouter({ moltbookDaemon: daemon });
    whatsApp.simulateMessage(makeMsg('/plan kuramoto', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent.length).toBeGreaterThanOrEqual(2);
    });

    expect(generatePlanFn).toHaveBeenCalledWith('kuramoto');
    expect(whatsApp.sent[1].text).toContain('No engagement targets found');
  });

  it('/plan without daemon sends not-running', async () => {
    router = buildRouter();
    whatsApp.simulateMessage(makeMsg('/plan', USER_JID));

    await vi.waitFor(() => {
      expect(whatsApp.sent).toHaveLength(1);
    });
    expect(whatsApp.sent[0].text).toContain('Moltbook daemon not running');
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
