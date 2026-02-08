/**
 * Session Persistence Layer
 *
 * Persists and restores AgentZero state snapshots.
 * Two implementations:
 * - InMemorySessionStore: volatile, for testing and ephemeral sessions
 * - FileSessionStore: JSON files on disk, survives restarts
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentState, Token, Drift, Realizability } from '../primitives/types.js';
import type { AgentZero } from './agent-zero.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SessionSnapshot {
  id: string;
  agentId: string;
  agentName: string;
  state: AgentState;
  tokens: Token[];
  drift: Drift;
  observerPhase: number;
  observerFrequency: number;
  memories: Array<{
    content: string;
    embedding: number[];
    importance: number;
    timestamp: number;
  }>;
  realizability: Realizability;
  childIds: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface SessionStore {
  save(agent: AgentZero): Promise<SessionSnapshot>;
  load(snapshotId: string): Promise<SessionSnapshot | null>;
  restore(agent: AgentZero, snapshot: SessionSnapshot): void;
  list(agentId?: string): Promise<Array<{ id: string; agentId: string; agentName: string; createdAt: number }>>;
  delete(snapshotId: string): Promise<void>;
}

// ============================================================================
// SNAPSHOT EXTRACTION
// ============================================================================

function extractSnapshot(agent: AgentZero, metadata?: Record<string, unknown>): SessionSnapshot {
  const agentState = agent.getState();
  return {
    id: randomUUID(),
    agentId: agentState.id,
    agentName: agentState.name,
    state: agentState.state,
    tokens: structuredClone(agentState.tokens),
    drift: structuredClone(agentState.drift),
    observerPhase: agentState.observer.phase,
    observerFrequency: agentState.observer.frequency,
    memories: structuredClone(agentState.memories),
    realizability: structuredClone(agentState.realizability),
    childIds: agent.getChildren().map(c => c.id),
    createdAt: Date.now(),
    metadata,
  };
}

// ============================================================================
// IN-MEMORY IMPLEMENTATION
// ============================================================================

export class InMemorySessionStore implements SessionStore {
  private snapshots: Map<string, SessionSnapshot> = new Map();

  async save(agent: AgentZero): Promise<SessionSnapshot> {
    const snapshot = extractSnapshot(agent);
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  async load(snapshotId: string): Promise<SessionSnapshot | null> {
    return this.snapshots.get(snapshotId) ?? null;
  }

  restore(agent: AgentZero, snapshot: SessionSnapshot): void {
    agent.restoreFromSnapshot(snapshot);
  }

  async list(agentId?: string): Promise<Array<{ id: string; agentId: string; agentName: string; createdAt: number }>> {
    const entries: Array<{ id: string; agentId: string; agentName: string; createdAt: number }> = [];
    for (const snap of this.snapshots.values()) {
      if (agentId && snap.agentId !== agentId) continue;
      entries.push({
        id: snap.id,
        agentId: snap.agentId,
        agentName: snap.agentName,
        createdAt: snap.createdAt,
      });
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(snapshotId: string): Promise<void> {
    this.snapshots.delete(snapshotId);
  }
}

// ============================================================================
// FILE-BACKED IMPLEMENTATION
// ============================================================================

export class FileSessionStore implements SessionStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  async save(agent: AgentZero): Promise<SessionSnapshot> {
    const snapshot = extractSnapshot(agent);
    const filePath = join(this.dir, `${snapshot.id}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot), 'utf-8');
    return snapshot;
  }

  async load(snapshotId: string): Promise<SessionSnapshot | null> {
    const filePath = join(this.dir, `${snapshotId}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as SessionSnapshot;
    } catch {
      return null;
    }
  }

  restore(agent: AgentZero, snapshot: SessionSnapshot): void {
    agent.restoreFromSnapshot(snapshot);
  }

  async list(agentId?: string): Promise<Array<{ id: string; agentId: string; agentName: string; createdAt: number }>> {
    const entries: Array<{ id: string; agentId: string; agentName: string; createdAt: number }> = [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), 'utf-8');
        const snap = JSON.parse(raw) as SessionSnapshot;
        if (agentId && snap.agentId !== agentId) continue;
        entries.push({
          id: snap.id,
          agentId: snap.agentId,
          agentName: snap.agentName,
          createdAt: snap.createdAt,
        });
      } catch {
        // Skip corrupt files
      }
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(snapshotId: string): Promise<void> {
    const filePath = join(this.dir, `${snapshotId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}
