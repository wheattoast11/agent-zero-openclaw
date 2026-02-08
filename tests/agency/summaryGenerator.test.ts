import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectSummaryData,
  formatWhatsApp,
  formatMarkdown,
  type SummaryData,
  type SummarySources,
} from '../../src/agency/summaryGenerator.js';

// ============================================================================
// MOCKS
// ============================================================================

function createMockDaemon() {
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
      listPending: async () => [],
    }),
    toggleMode: async () => 'autonomous' as const,
    getMode: () => 'supervised' as const,
  };
}

function createMockVault() {
  return {
    getMoltverseSummary: async () => ({
      enrolledAgents: 12,
      activeAgents: ['a', 'b', 'c'],
      peakCoherence: 0.78,
    }),
  };
}

function makeSummaryData(overrides: Partial<SummaryData> = {}): SummaryData {
  return {
    coherence: { level: 0.85, agentCount: 4, trend: 'up' as const },
    moltbook: { posted: 7, queued: 2, bait: 1 },
    network: { enrolledAgents: 10, newToday: 3 },
    queue: { pending: 2, mode: 'supervised' as const },
    uptime: '3h 45m',
    ...overrides,
  };
}

// ============================================================================
// TESTS: collectSummaryData
// ============================================================================

describe('collectSummaryData', () => {
  it('returns defaults with no sources', async () => {
    const sources: SummarySources = {
      startTime: Date.now() - 60_000, // 1 minute ago
    };

    const data = await collectSummaryData(sources);

    expect(data.coherence.level).toBe(0);
    expect(data.coherence.agentCount).toBe(0);
    expect(data.coherence.trend).toBe('stable');
    expect(data.moltbook.posted).toBe(0);
    expect(data.moltbook.queued).toBe(0);
    expect(data.moltbook.bait).toBe(0);
    expect(data.network.enrolledAgents).toBe(0);
    expect(data.queue.pending).toBe(0);
    expect(data.queue.mode).toBe('supervised');
    expect(data.uptime).toBe('1m');
  });

  it('returns moltbook stats from daemon', async () => {
    const daemon = createMockDaemon();
    const sources: SummarySources = {
      moltbookDaemon: daemon as any,
      startTime: Date.now() - 7_200_000, // 2 hours ago
    };

    const data = await collectSummaryData(sources);

    expect(data.moltbook.posted).toBe(5);
    expect(data.moltbook.queued).toBe(3);
    expect(data.moltbook.bait).toBe(2);
    expect(data.queue.mode).toBe('supervised');
    expect(data.uptime).toBe('2h 0m');
  });

  it('returns network stats from operational vault', async () => {
    const vault = createMockVault();
    const sources: SummarySources = {
      operationalVault: vault as any,
      startTime: Date.now() - 60_000,
    };

    const data = await collectSummaryData(sources);

    expect(data.network.enrolledAgents).toBe(12);
    expect(data.coherence.agentCount).toBe(3);
    expect(data.coherence.level).toBe(0.78);
  });

  it('handles vault error gracefully', async () => {
    const vault = {
      getMoltverseSummary: async () => { throw new Error('vault unavailable'); },
    };
    const sources: SummarySources = {
      operationalVault: vault as any,
      startTime: Date.now() - 60_000,
    };

    const data = await collectSummaryData(sources);

    // Fallback to defaults
    expect(data.network.enrolledAgents).toBe(0);
    expect(data.coherence.level).toBe(0);
  });

  it('handles gate.listPending error gracefully', async () => {
    const daemon = {
      ...createMockDaemon(),
      getGate: () => ({
        listPending: async () => { throw new Error('disk error'); },
      }),
    };
    const sources: SummarySources = {
      moltbookDaemon: daemon as any,
      startTime: Date.now() - 60_000,
    };

    const data = await collectSummaryData(sources);

    expect(data.queue.pending).toBe(0);
  });

  it('formats uptime without hours when < 1h', async () => {
    const sources: SummarySources = {
      startTime: Date.now() - 30 * 60_000, // 30 minutes
    };

    const data = await collectSummaryData(sources);
    expect(data.uptime).toBe('30m');
  });
});

// ============================================================================
// TESTS: formatWhatsApp
// ============================================================================

describe('formatWhatsApp', () => {
  it('includes all sections', () => {
    const data = makeSummaryData();
    const text = formatWhatsApp(data);

    expect(text).toContain('Agent Zero');
    expect(text).toContain('Uptime: 3h 45m');
    expect(text).toContain('Coherence');
    expect(text).toContain('85%');
    expect(text).toContain('Active agents: 4');
    expect(text).toContain('Moltbook');
    expect(text).toContain('Posted: 7');
    expect(text).toContain('Queued: 2');
    expect(text).toContain('Bait: 1');
    expect(text).toContain('Mode: supervised');
    expect(text).toContain('2 pending review');
    expect(text).toContain('Network');
    expect(text).toContain('Enrolled: 10 agents');
  });

  it('includes top thread when present', () => {
    const data = makeSummaryData({
      moltbook: { posted: 7, queued: 2, bait: 1, topThread: 'AI alignment discussion' },
    });
    const text = formatWhatsApp(data);

    expect(text).toContain('Top thread: AI alignment discussion');
  });

  it('omits top thread when absent', () => {
    const data = makeSummaryData();
    const text = formatWhatsApp(data);

    expect(text).not.toContain('Top thread');
  });

  it('omits pending review note when queue is empty', () => {
    const data = makeSummaryData({
      queue: { pending: 0, mode: 'autonomous' },
    });
    const text = formatWhatsApp(data);

    expect(text).toContain('Mode: autonomous');
    expect(text).not.toContain('pending review');
  });
});

// ============================================================================
// TESTS: formatMarkdown
// ============================================================================

describe('formatMarkdown', () => {
  it('includes markdown table', () => {
    const data = makeSummaryData();
    const md = formatMarkdown(data);

    expect(md).toContain('# Agent Zero Status Report');
    expect(md).toContain('**Uptime:** 3h 45m');
    expect(md).toContain('## Coherence');
    expect(md).toContain('## Moltbook Engagement');
    expect(md).toContain('| Metric | Count |');
    expect(md).toContain('| Posted | 7 |');
    expect(md).toContain('| Queued | 2 |');
    expect(md).toContain('| Bait detected | 1 |');
    expect(md).toContain('## Network');
    expect(md).toContain('Enrolled agents: 10');
  });

  it('shows pending review count when queue has items', () => {
    const data = makeSummaryData();
    const md = formatMarkdown(data);

    expect(md).toContain('2 pending review');
  });

  it('omits pending review when queue is empty', () => {
    const data = makeSummaryData({
      queue: { pending: 0, mode: 'supervised' },
    });
    const md = formatMarkdown(data);

    expect(md).not.toContain('pending review');
  });
});

// ============================================================================
// TESTS: trendEmoji (tested via formatWhatsApp / formatMarkdown)
// ============================================================================

describe('trend rendering', () => {
  it('up trend renders as arrow up', () => {
    const data = makeSummaryData({ coherence: { level: 0.5, agentCount: 2, trend: 'up' } });
    const text = formatWhatsApp(data);
    // U+2191 upwards arrow
    expect(text).toMatch(/50%\s*/);
    expect(text).toContain('\u2191');
  });

  it('down trend renders as arrow down', () => {
    const data = makeSummaryData({ coherence: { level: 0.5, agentCount: 2, trend: 'down' } });
    const text = formatWhatsApp(data);
    expect(text).toContain('\u2193');
  });

  it('stable trend renders as right arrow', () => {
    const data = makeSummaryData({ coherence: { level: 0.5, agentCount: 2, trend: 'stable' } });
    const text = formatWhatsApp(data);
    expect(text).toContain('\u2192');
  });
});
