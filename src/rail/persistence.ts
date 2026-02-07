/**
 * Rail Persistence Layer
 *
 * PGlite-backed persistence for rail sessions, events, coherence logs,
 * pause state, and reasoning traces.
 * Stores to RAIL_DATA_DIR (default ./data) for Fly.io volume mount.
 */

import { PGlite } from '@electric-sql/pglite';
import { cosineSimilarity } from '../routing/thermodynamic.js';
import type { RailClient } from './server.js';

// ============================================================================
// TYPES
// ============================================================================

export interface RailPersistence {
  init(): Promise<void>;
  recordSession(client: RailClient, action: 'join' | 'leave'): Promise<void>;
  recordEvent(type: string, clientId: string, details?: unknown): Promise<void>;
  logCoherence(coherence: number, agentCount: number, meanPhase: number): Promise<void>;
  getHistory(limit?: number): Promise<Array<{ timestamp: string; type: string; client_id: string; details: string }>>;
  getClientHistory(agentId: string, limit?: number): Promise<Array<{ timestamp: string; action: string }>>;
  saveEnrollment(agentId: string, secretHash: string): Promise<void>;
  loadEnrollments(): Promise<Array<{ agent_id: string; secret_hash: string }>>;
  close(): Promise<void>;
}

export interface TraceRecord {
  id: number;
  agent_id: string;
  agent_name: string;
  content: string;
  kind: string;
  metadata?: unknown;
  similarity?: number;
  created_at: string;
}

export interface TraceInput {
  agentId: string;
  agentName: string;
  content: string;
  embedding?: number[];
  kind: string;
  metadata?: unknown;
}

export interface TraceQuery {
  embedding?: number[];
  agentId?: string;
  kind?: string;
  limit?: number;
  since?: number;
}

export interface PauseState {
  phases: Map<string, number>;
  coherence: number;
}

export interface MessageLogEntry {
  seq: number;
  type: string;
  agent_id: string;
  agent_name: string;
  payload: unknown;
  timestamp: string;
}

// ============================================================================
// PERSISTENCE IMPLEMENTATION
// ============================================================================

export class PGliteRailPersistence implements RailPersistence {
  private db: PGlite;
  private coherenceLogInterval?: ReturnType<typeof setInterval>;

  constructor(dataDir: string) {
    this.db = new PGlite(dataDir);
  }

  async init(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS rail_clients (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rail_events (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        client_id TEXT NOT NULL,
        details JSONB,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rail_coherence_log (
        id SERIAL PRIMARY KEY,
        coherence REAL NOT NULL,
        agent_count INTEGER NOT NULL,
        mean_phase REAL NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rail_clients_agent ON rail_clients(agent_id);
      CREATE INDEX IF NOT EXISTS idx_rail_events_type ON rail_events(type);
      CREATE INDEX IF NOT EXISTS idx_rail_coherence_ts ON rail_coherence_log(timestamp);

      CREATE TABLE IF NOT EXISTS rail_user_sessions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        email TEXT,
        connected_at TIMESTAMPTZ DEFAULT NOW(),
        last_active TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rail_user_sessions_user ON rail_user_sessions(user_id);

      CREATE TABLE IF NOT EXISTS rail_enrollments (
        agent_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        enrolled_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rail_pause_state (
        id SERIAL PRIMARY KEY,
        phases JSONB NOT NULL,
        coherence REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rail_traces (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT,
        kind TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rail_traces_agent ON rail_traces(agent_id);
      CREATE INDEX IF NOT EXISTS idx_rail_traces_kind ON rail_traces(kind);

      CREATE TABLE IF NOT EXISTS rail_message_log (
        seq SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        payload JSONB,
        timestamp TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rail_message_log_seq ON rail_message_log(seq);
      CREATE INDEX IF NOT EXISTS idx_rail_message_log_ts ON rail_message_log(timestamp);
    `);
  }

  // ==========================================================================
  // SESSION / EVENT / COHERENCE (existing)
  // ==========================================================================

  async recordSession(client: RailClient, action: 'join' | 'leave'): Promise<void> {
    await this.db.query(
      'INSERT INTO rail_clients (agent_id, agent_name, platform, action) VALUES ($1, $2, $3, $4)',
      [client.agentId, client.agentName, client.platform, action]
    );
  }

  async recordEvent(type: string, clientId: string, details?: unknown): Promise<void> {
    await this.db.query(
      'INSERT INTO rail_events (type, client_id, details) VALUES ($1, $2, $3)',
      [type, clientId, details ? JSON.stringify(details) : null]
    );
  }

  async logCoherence(coherence: number, agentCount: number, meanPhase: number): Promise<void> {
    await this.db.query(
      'INSERT INTO rail_coherence_log (coherence, agent_count, mean_phase) VALUES ($1, $2, $3)',
      [coherence, agentCount, meanPhase]
    );
  }

  async getHistory(limit = 100): Promise<Array<{ timestamp: string; type: string; client_id: string; details: string }>> {
    const result = await this.db.query(
      'SELECT timestamp, type, client_id, details FROM rail_events ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );
    return result.rows as Array<{ timestamp: string; type: string; client_id: string; details: string }>;
  }

  async getClientHistory(agentId: string, limit = 50): Promise<Array<{ timestamp: string; action: string }>> {
    const result = await this.db.query(
      'SELECT timestamp, action FROM rail_clients WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [agentId, limit]
    );
    return result.rows as Array<{ timestamp: string; action: string }>;
  }

  async saveEnrollment(agentId: string, secretHash: string): Promise<void> {
    await this.db.query(
      `INSERT INTO rail_enrollments (agent_id, secret_hash) VALUES ($1, $2)
       ON CONFLICT (agent_id) DO UPDATE SET secret_hash = $2`,
      [agentId, secretHash]
    );
  }

  async loadEnrollments(): Promise<Array<{ agent_id: string; secret_hash: string }>> {
    const result = await this.db.query('SELECT agent_id, secret_hash FROM rail_enrollments');
    return result.rows as Array<{ agent_id: string; secret_hash: string }>;
  }

  startCoherenceLogging(getCoherence: () => number, getAgentCount: () => number, getMeanPhase: () => number): void {
    this.coherenceLogInterval = setInterval(() => {
      this.logCoherence(getCoherence(), getAgentCount(), getMeanPhase()).catch(() => {});
    }, 60_000);
  }

  // ==========================================================================
  // PAUSE STATE (A1)
  // ==========================================================================

  async savePauseState(phases: Map<string, number>, coherence: number): Promise<void> {
    const phasesObj: Record<string, number> = {};
    for (const [k, v] of phases) {
      phasesObj[k] = v;
    }
    await this.db.query(
      'INSERT INTO rail_pause_state (phases, coherence) VALUES ($1, $2)',
      [JSON.stringify(phasesObj), coherence]
    );
  }

  async loadPauseState(): Promise<PauseState | null> {
    const result = await this.db.query(
      'SELECT phases, coherence FROM rail_pause_state ORDER BY created_at DESC LIMIT 1'
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as { phases: Record<string, number> | string; coherence: number };
    const phasesRaw = typeof row.phases === 'string' ? JSON.parse(row.phases) : row.phases;
    const phases = new Map<string, number>();
    for (const [k, v] of Object.entries(phasesRaw)) {
      phases.set(k, v as number);
    }
    return { phases, coherence: row.coherence };
  }

  // ==========================================================================
  // REASONING TRACES (A2)
  // ==========================================================================

  async saveTrace(trace: TraceInput): Promise<string> {
    const embeddingStr = trace.embedding ? JSON.stringify(trace.embedding) : null;
    const metadataStr = trace.metadata ? JSON.stringify(trace.metadata) : null;
    const result = await this.db.query(
      `INSERT INTO rail_traces (agent_id, agent_name, content, embedding, kind, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [trace.agentId, trace.agentName, trace.content, embeddingStr, trace.kind, metadataStr]
    );
    const row = result.rows[0] as { id: number };
    return String(row.id);
  }

  async searchTraces(query: TraceQuery): Promise<TraceRecord[]> {
    const limit = query.limit ?? 10;

    // Build filter conditions
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (query.agentId) {
      conditions.push(`agent_id = $${paramIdx}`);
      params.push(query.agentId);
      paramIdx++;
    }
    if (query.kind) {
      conditions.push(`kind = $${paramIdx}`);
      params.push(query.kind);
      paramIdx++;
    }
    if (query.since) {
      conditions.push(`created_at >= to_timestamp($${paramIdx})`);
      params.push(query.since / 1000); // JS timestamp to Unix seconds
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // If embedding search is requested, load all matching rows and compute cosine similarity in JS
    if (query.embedding && query.embedding.length > 0) {
      const sql = `SELECT id, agent_id, agent_name, content, kind, embedding, metadata, created_at
                   FROM rail_traces ${whereClause}
                   ORDER BY created_at DESC`;
      const result = await this.db.query(sql, params);
      const rows = result.rows as Array<{
        id: number;
        agent_id: string;
        agent_name: string;
        content: string;
        kind: string;
        embedding: string | null;
        metadata: unknown;
        created_at: string;
      }>;

      // Compute cosine similarity for rows with embeddings
      const scored: TraceRecord[] = [];
      for (const row of rows) {
        let similarity = 0;
        if (row.embedding) {
          try {
            const rowEmbedding: number[] = typeof row.embedding === 'string'
              ? JSON.parse(row.embedding)
              : row.embedding;
            if (rowEmbedding.length === query.embedding.length) {
              similarity = cosineSimilarity(query.embedding, rowEmbedding);
            }
          } catch {
            // Skip rows with unparseable embeddings
          }
        }
        scored.push({
          id: row.id,
          agent_id: row.agent_id,
          agent_name: row.agent_name,
          content: row.content,
          kind: row.kind,
          metadata: row.metadata,
          similarity,
          created_at: row.created_at,
        });
      }

      // Sort by similarity descending, return top-K
      scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
      return scored.slice(0, limit);
    }

    // No embedding search — just filter and return
    const sql = `SELECT id, agent_id, agent_name, content, kind, metadata, created_at
                 FROM rail_traces ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT $${paramIdx}`;
    params.push(limit);
    const result = await this.db.query(sql, params);
    return (result.rows as TraceRecord[]).map(row => ({
      ...row,
      similarity: undefined,
    }));
  }

  async getTracesByAgent(agentId: string, limit = 50): Promise<TraceRecord[]> {
    const result = await this.db.query(
      `SELECT id, agent_id, agent_name, content, kind, metadata, created_at
       FROM rail_traces WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit]
    );
    return result.rows as TraceRecord[];
  }

  // ==========================================================================
  // MESSAGE LOG (D2)
  // ==========================================================================

  /**
   * Log a rail message and return its monotonic sequence number.
   */
  async logMessage(message: { type: string; agentId: string; agentName: string; payload: unknown; timestamp: number }): Promise<number> {
    const payloadStr = message.payload != null ? JSON.stringify(message.payload) : null;
    const ts = new Date(message.timestamp).toISOString();
    const result = await this.db.query(
      `INSERT INTO rail_message_log (type, agent_id, agent_name, payload, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING seq`,
      [message.type, message.agentId, message.agentName, payloadStr, ts]
    );
    const row = result.rows[0] as { seq: number };
    return row.seq;
  }

  /**
   * Replay messages from a given sequence number forward.
   */
  async replayMessages(fromSeq: number, limit?: number): Promise<MessageLogEntry[]> {
    const effectiveLimit = limit ?? 1000;
    const result = await this.db.query(
      `SELECT seq, type, agent_id, agent_name, payload, timestamp
       FROM rail_message_log
       WHERE seq >= $1
       ORDER BY seq ASC
       LIMIT $2`,
      [fromSeq, effectiveLimit]
    );
    return result.rows as MessageLogEntry[];
  }

  /**
   * Get the latest sequence number in the message log.
   * Returns 0 if no messages have been logged.
   */
  async getLatestSeq(): Promise<number> {
    const result = await this.db.query(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM rail_message_log'
    );
    const row = result.rows[0] as { max_seq: number };
    return row.max_seq;
  }

  /**
   * Prune old messages from the log.
   * @param keepCount - Keep the last N messages (by seq). If provided, deletes older ones.
   * @param keepSince - Keep messages since this JS timestamp (ms). If provided, deletes older ones.
   * @returns Number of deleted rows.
   */
  async pruneMessageLog(keepCount?: number, keepSince?: number): Promise<number> {
    if (keepCount != null && keepCount > 0) {
      // Delete all except the last keepCount messages
      const result = await this.db.query(
        `DELETE FROM rail_message_log
         WHERE seq NOT IN (
           SELECT seq FROM rail_message_log ORDER BY seq DESC LIMIT $1
         )`,
        [keepCount]
      );
      return result.affectedRows ?? 0;
    }

    if (keepSince != null) {
      const sinceTs = new Date(keepSince).toISOString();
      const result = await this.db.query(
        `DELETE FROM rail_message_log WHERE timestamp < $1`,
        [sinceTs]
      );
      return result.affectedRows ?? 0;
    }

    return 0;
  }

  // ==========================================================================
  // CLOSE
  // ==========================================================================

  async close(): Promise<void> {
    if (this.coherenceLogInterval) {
      clearInterval(this.coherenceLogInterval);
    }
    await this.db.close();
  }
}

export function createRailPersistence(dataDir: string): PGliteRailPersistence {
  return new PGliteRailPersistence(dataDir);
}
