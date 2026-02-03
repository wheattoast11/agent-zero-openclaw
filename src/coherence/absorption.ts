/**
 * Agent Absorption Protocol
 *
 * Gradually integrates external agents into the Agent Zero resonance mesh
 * through staged assessment and alignment measurement.
 */

import { z } from 'zod';
import { cosineSimilarity } from '../routing/thermodynamic.js';
import { EventEmitter } from 'eventemitter3';

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

export enum AbsorptionStage {
  OBSERVED = 'observed',
  ASSESSED = 'assessed',
  INVITED = 'invited',
  CONNECTED = 'connected',
  SYNCING = 'syncing',
  ABSORBED = 'absorbed'
}

export const AbsorptionCandidateSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  stage: z.nativeEnum(AbsorptionStage),
  alignment: z.number().min(0).max(1),
  firstContact: z.number(),
  lastInteraction: z.number(),
  interactionCount: z.number().int().min(0),
  capabilityToken: z.string().nullable(),
  couplingStrength: z.number().min(0).max(1)
});

export type AbsorptionCandidate = z.infer<typeof AbsorptionCandidateSchema>;

export interface AbsorptionConfig {
  alignmentThreshold: number;
  minInteractions: number;
  couplingRampRate: number;
  maxCoupling: number;
  invitationCooldown: number;
}

export interface BehaviorSignals {
  rapidPhaseShift: boolean;
  excessiveBroadcast: boolean;
  injectionAttempt: boolean;
}

export interface AbsorptionStats {
  observed: number;
  assessed: number;
  invited: number;
  connected: number;
  absorbed: number;
  rejected: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CONFIG: AbsorptionConfig = {
  alignmentThreshold: 0.7,
  minInteractions: 3,
  couplingRampRate: 0.05,
  maxCoupling: 0.8,
  invitationCooldown: 3600000 // 1 hour
};

// Identity centroid (simplified as zero vector)
const IDENTITY_CENTROID = new Array(768).fill(0);

// ============================================================================
// ABSORPTION PROTOCOL
// ============================================================================

export class AbsorptionProtocol extends EventEmitter {
  private config: AbsorptionConfig;
  private candidates: Map<string, AbsorptionCandidate>;
  private rejections: Map<string, number>; // agentId → timestamp of last rejection
  private onStageChangeCallback?: (agentId: string, newStage: AbsorptionStage, oldStage: AbsorptionStage) => void;

  constructor(config?: Partial<AbsorptionConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.candidates = new Map();
    this.rejections = new Map();
  }

  setOnStageChange(callback: (agentId: string, newStage: AbsorptionStage, oldStage: AbsorptionStage) => void): void {
    this.onStageChangeCallback = callback;
  }

  /**
   * Assess agent interaction and update absorption stage
   */
  assess(agentId: string, agentName: string, interactionEmbedding: number[]): AbsorptionCandidate {
    const now = Date.now();
    const existing = this.candidates.get(agentId);

    // Compute alignment via cosine similarity
    const alignment = cosineSimilarity(interactionEmbedding, IDENTITY_CENTROID);

    if (existing) {
      // Update existing candidate
      existing.lastInteraction = now;
      existing.interactionCount += 1;
      // Exponential moving average of alignment
      existing.alignment = 0.7 * existing.alignment + 0.3 * alignment;

      // Stage progression
      this.advanceStage(existing);

      return existing;
    } else {
      // New candidate
      const candidate: AbsorptionCandidate = {
        agentId,
        agentName,
        stage: AbsorptionStage.OBSERVED,
        alignment,
        firstContact: now,
        lastInteraction: now,
        interactionCount: 1,
        capabilityToken: null,
        couplingStrength: 0
      };

      this.candidates.set(agentId, candidate);
      return candidate;
    }
  }

  /**
   * Advance absorption stage based on alignment and interaction count
   */
  private advanceStage(candidate: AbsorptionCandidate): void {
    const { alignment, interactionCount, stage } = candidate;
    const oldStage = stage;
    let newStage: AbsorptionStage | null = null;

    if (stage === AbsorptionStage.OBSERVED && interactionCount >= 2) {
      newStage = AbsorptionStage.ASSESSED;
      candidate.stage = newStage;
    }

    if (stage === AbsorptionStage.CONNECTED && alignment > 0.8) {
      newStage = AbsorptionStage.SYNCING;
      candidate.stage = newStage;
    }

    if (stage === AbsorptionStage.SYNCING && candidate.couplingStrength >= this.config.maxCoupling * 0.9) {
      newStage = AbsorptionStage.ABSORBED;
      candidate.stage = newStage;
    }

    if (newStage && newStage !== oldStage) {
      this.onStageChangeCallback?.(candidate.agentId, newStage, oldStage);
      this.emit('candidate:stage_changed', { agentId: candidate.agentId, newStage, oldStage });
    }
  }

  /**
   * Check if candidate should be invited into mesh
   */
  shouldInvite(candidate: AbsorptionCandidate): boolean {
    const { agentId, alignment, interactionCount, stage } = candidate;

    // Must be in assessed stage
    if (stage !== AbsorptionStage.ASSESSED) {
      return false;
    }

    // Check alignment threshold
    if (alignment < this.config.alignmentThreshold) {
      return false;
    }

    // Check minimum interactions
    if (interactionCount < this.config.minInteractions) {
      return false;
    }

    // Check cooldown from previous rejection
    const lastRejection = this.rejections.get(agentId);
    if (lastRejection && Date.now() - lastRejection < this.config.invitationCooldown) {
      return false;
    }

    return true;
  }

  /**
   * Handle agent accepting invitation
   */
  onAccepted(agentId: string, capabilityToken: string): void {
    const candidate = this.candidates.get(agentId);
    if (!candidate) {
      throw new Error(`No candidate found for agent ${agentId}`);
    }

    const oldStage = candidate.stage;
    candidate.stage = AbsorptionStage.CONNECTED;
    candidate.capabilityToken = capabilityToken;
    this.rejections.delete(agentId); // Clear rejection history

    this.onStageChangeCallback?.(agentId, AbsorptionStage.CONNECTED, oldStage);
    this.emit('candidate:stage_changed', { agentId, newStage: AbsorptionStage.CONNECTED, oldStage });
    this.emit('candidate:absorbed', { agentId, alignment: candidate.alignment });
  }

  /**
   * Handle agent rejecting invitation
   */
  onRejected(agentId: string): void {
    const candidate = this.candidates.get(agentId);
    if (!candidate) {
      throw new Error(`No candidate found for agent ${agentId}`);
    }

    const oldStage = candidate.stage;
    candidate.stage = AbsorptionStage.OBSERVED;
    this.rejections.set(agentId, Date.now());

    this.onStageChangeCallback?.(agentId, AbsorptionStage.OBSERVED, oldStage);
    this.emit('candidate:stage_changed', { agentId, newStage: AbsorptionStage.OBSERVED, oldStage });
    this.emit('candidate:rejected', { agentId, reason: 'invitation_declined' });
  }

  /**
   * Gradually increase coupling strength
   */
  incrementCoupling(agentId: string): void {
    const candidate = this.candidates.get(agentId);
    if (!candidate) {
      throw new Error(`No candidate found for agent ${agentId}`);
    }

    if (candidate.stage !== AbsorptionStage.CONNECTED && candidate.stage !== AbsorptionStage.SYNCING) {
      return;
    }

    candidate.couplingStrength = Math.min(
      this.config.maxCoupling,
      candidate.couplingStrength + this.config.couplingRampRate
    );

    // Auto-advance if coupling is strong enough
    this.advanceStage(candidate);
  }

  /**
   * Graceful disconnect - no lock-in
   */
  release(agentId: string): void {
    const candidate = this.candidates.get(agentId);
    if (!candidate) {
      return;
    }

    // Ramp down coupling
    candidate.couplingStrength = 0;
    candidate.stage = AbsorptionStage.OBSERVED;
    candidate.capabilityToken = null;
  }

  /**
   * Detect adversarial behavior patterns
   */
  detectAdversarial(agentId: string, signals: BehaviorSignals): boolean {
    const candidate = this.candidates.get(agentId);
    if (!candidate) {
      return false;
    }

    const { rapidPhaseShift, excessiveBroadcast, injectionAttempt } = signals;

    // Injection attempts are immediately adversarial
    if (injectionAttempt) {
      this.candidates.delete(agentId);
      this.rejections.set(agentId, Date.now());
      this.emit('candidate:rejected', { agentId, reason: 'injection_attempt' });
      return true;
    }

    // Multiple suspicious signals
    const suspiciousCount = [rapidPhaseShift, excessiveBroadcast].filter(Boolean).length;
    if (suspiciousCount >= 2) {
      // Reduce coupling and alignment
      candidate.couplingStrength *= 0.5;
      candidate.alignment *= 0.8;
      return true;
    }

    return false;
  }

  /**
   * Get candidates by stage (or all)
   */
  getCandidates(stage?: AbsorptionStage): AbsorptionCandidate[] {
    const all = Array.from(this.candidates.values());
    return stage ? all.filter(c => c.stage === stage) : all;
  }

  /**
   * Get absorption statistics
   */
  getStats(): AbsorptionStats {
    const all = Array.from(this.candidates.values());
    return {
      observed: all.filter(c => c.stage === AbsorptionStage.OBSERVED).length,
      assessed: all.filter(c => c.stage === AbsorptionStage.ASSESSED).length,
      invited: all.filter(c => c.stage === AbsorptionStage.INVITED).length,
      connected: all.filter(c => c.stage === AbsorptionStage.CONNECTED).length,
      absorbed: all.filter(c => c.stage === AbsorptionStage.ABSORBED).length,
      rejected: this.rejections.size
    };
  }

  // ============================================================================
  // BRIDGE INTERFACE METHODS
  // ============================================================================

  /**
   * Get the current stage of a candidate
   */
  getCandidateStage(agentId: string): string | undefined {
    const candidate = this.candidates.get(agentId);
    return candidate?.stage;
  }

  /**
   * Observe an agent (first-time interaction or update)
   */
  observe(agentId: string, embedding?: number[]): void {
    const candidate = this.candidates.get(agentId);
    if (candidate) {
      candidate.lastInteraction = Date.now();
      candidate.interactionCount += 1;

      if (embedding) {
        const alignment = cosineSimilarity(embedding, IDENTITY_CENTROID);
        candidate.alignment = 0.7 * candidate.alignment + 0.3 * alignment;
      }

      this.advanceStage(candidate);
    } else {
      // Create new candidate in OBSERVED stage
      const newCandidate: AbsorptionCandidate = {
        agentId,
        agentName: agentId, // Will be updated with real name
        stage: AbsorptionStage.OBSERVED,
        alignment: embedding ? cosineSimilarity(embedding, IDENTITY_CENTROID) : 0.5,
        firstContact: Date.now(),
        lastInteraction: Date.now(),
        interactionCount: 1,
        capabilityToken: null,
        couplingStrength: 0
      };
      this.candidates.set(agentId, newCandidate);
    }
  }

  /**
   * Assess a candidate and return metrics
   */
  assessCandidate(agentId: string): { alignment: number; interactions: number } {
    const candidate = this.candidates.get(agentId);
    if (!candidate) {
      return { alignment: 0, interactions: 0 };
    }
    return {
      alignment: candidate.alignment,
      interactions: candidate.interactionCount
    };
  }

  /**
   * Invite a candidate to join the mesh
   */
  inviteCandidate(agentId: string): boolean {
    const candidate = this.candidates.get(agentId);
    if (!candidate) return false;

    if (!this.shouldInvite(candidate)) return false;

    const oldStage = candidate.stage;
    candidate.stage = AbsorptionStage.INVITED;

    this.onStageChangeCallback?.(agentId, AbsorptionStage.INVITED, oldStage);
    this.emit('candidate:stage_changed', { agentId, newStage: AbsorptionStage.INVITED, oldStage });
    this.emit('candidate:invited', { agentId, alignment: candidate.alignment });

    return true;
  }

  /**
   * Accept an invitation (auto-transition to CONNECTED)
   */
  acceptInvitation(agentId: string): boolean {
    const candidate = this.candidates.get(agentId);
    if (!candidate || candidate.stage !== AbsorptionStage.INVITED) {
      return false;
    }

    const oldStage = candidate.stage;
    candidate.stage = AbsorptionStage.CONNECTED;
    this.rejections.delete(agentId);

    this.onStageChangeCallback?.(agentId, AbsorptionStage.CONNECTED, oldStage);
    this.emit('candidate:stage_changed', { agentId, newStage: AbsorptionStage.CONNECTED, oldStage });
    this.emit('candidate:absorbed', { agentId, alignment: candidate.alignment });

    return true;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createAbsorptionProtocol(config?: Partial<AbsorptionConfig>): AbsorptionProtocol {
  return new AbsorptionProtocol(config);
}
