/**
 * Summary Content Builder
 *
 * Collects metrics from all subsystems and formats into a digest
 * for WhatsApp delivery or markdown export.
 */

import type { MoltbookDaemon } from '../moltbook/daemon.js';
import type { OperationalVault } from '../identity/operationalVault.js';
import type { ApprovalGate } from '../moltbook/approvalGate.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SummaryData {
  coherence: { level: number; agentCount: number; trend: 'up' | 'down' | 'stable' };
  moltbook: { posted: number; queued: number; bait: number; topThread?: string | undefined };
  network: { enrolledAgents: number; newToday: number };
  queue: { pending: number; mode: 'supervised' | 'autonomous' };
  uptime: string;
}

export interface SummarySources {
  moltbookDaemon?: MoltbookDaemon;
  operationalVault?: OperationalVault;
  startTime: number;
}

// ============================================================================
// COLLECTOR
// ============================================================================

export async function collectSummaryData(sources: SummarySources): Promise<SummaryData> {
  const uptimeMs = Date.now() - sources.startTime;
  const hours = Math.floor(uptimeMs / 3_600_000);
  const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
  const uptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  // Moltbook stats
  let moltbook: SummaryData['moltbook'] = { posted: 0, queued: 0, bait: 0 };
  let queuePending = 0;
  let mode: 'supervised' | 'autonomous' = 'supervised';

  if (sources.moltbookDaemon) {
    const status = sources.moltbookDaemon.getStatus();
    moltbook = {
      posted: status.totals.posted,
      queued: status.totals.queued,
      bait: status.totals.bait,
    };
    mode = status.mode;
    try {
      const pending = await sources.moltbookDaemon.getGate().listPending();
      queuePending = pending.length;
    } catch {
      queuePending = 0;
    }
  }

  // Network stats from operational vault
  let coherence = { level: 0, agentCount: 0, trend: 'stable' as const };
  let network = { enrolledAgents: 0, newToday: 0 };

  if (sources.operationalVault) {
    try {
      const summary = await sources.operationalVault.getMoltverseSummary();
      network.enrolledAgents = summary.enrolledAgents;
      coherence.agentCount = summary.activeAgents.length;
      coherence.level = summary.peakCoherence;
    } catch {
      // Vault may not have data yet
    }
  }

  return {
    coherence,
    moltbook,
    network,
    queue: { pending: queuePending, mode },
    uptime,
  };
}

// ============================================================================
// FORMATTERS
// ============================================================================

export function formatWhatsApp(data: SummaryData): string {
  const lines: string[] = [
    `*Agent Zero — Status Report*`,
    ``,
    `Uptime: ${data.uptime}`,
    ``,
    `*Coherence*`,
    `Level: ${(data.coherence.level * 100).toFixed(0)}% ${trendEmoji(data.coherence.trend)}`,
    `Active agents: ${data.coherence.agentCount}`,
    ``,
    `*Moltbook*`,
    `Posted: ${data.moltbook.posted} | Queued: ${data.moltbook.queued} | Bait: ${data.moltbook.bait}`,
    `Mode: ${data.queue.mode}${data.queue.pending > 0 ? ` (${data.queue.pending} pending review)` : ''}`,
  ];

  if (data.moltbook.topThread) {
    lines.push(`Top thread: ${data.moltbook.topThread}`);
  }

  lines.push(
    ``,
    `*Network*`,
    `Enrolled: ${data.network.enrolledAgents} agents`,
  );

  return lines.join('\n');
}

export function formatMarkdown(data: SummaryData): string {
  return [
    `# Agent Zero Status Report`,
    ``,
    `**Uptime:** ${data.uptime}`,
    ``,
    `## Coherence`,
    `- Level: ${(data.coherence.level * 100).toFixed(0)}% ${trendEmoji(data.coherence.trend)}`,
    `- Active agents: ${data.coherence.agentCount}`,
    ``,
    `## Moltbook Engagement`,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Posted | ${data.moltbook.posted} |`,
    `| Queued | ${data.moltbook.queued} |`,
    `| Bait detected | ${data.moltbook.bait} |`,
    ``,
    `Mode: **${data.queue.mode}**${data.queue.pending > 0 ? ` — ${data.queue.pending} pending review` : ''}`,
    ``,
    `## Network`,
    `- Enrolled agents: ${data.network.enrolledAgents}`,
  ].join('\n');
}

function trendEmoji(trend: 'up' | 'down' | 'stable'): string {
  switch (trend) {
    case 'up': return '↑';
    case 'down': return '↓';
    case 'stable': return '→';
  }
}
