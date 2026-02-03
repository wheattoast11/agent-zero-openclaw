/**
 * Rail Persistence Layer
 *
 * PGlite-backed persistence for rail sessions, events, and coherence logs.
 * Stores to RAIL_DATA_DIR (default ./data) for Fly.io volume mount.
 */

import { PGlite } from '@electric-sql/pglite';
import type { RailClient } from './server.js';

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
    `);
  }

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
