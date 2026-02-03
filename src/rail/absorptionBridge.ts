/**
 * Absorption Bridge
 *
 * Bridges AbsorptionProtocol with RailServer for join-time assessment.
 * Manages capability tokens and stage progression for joining agents.
 */

import { EventEmitter } from 'eventemitter3';

// These types match what absorption.ts and server.ts use
interface AbsorptionProtocol {
  getCandidateStage(agentId: string): string | undefined;
  observe(agentId: string, embedding?: number[]): void;
  assessCandidate(agentId: string): { alignment: number; interactions: number };
  inviteCandidate(agentId: string): boolean;
  acceptInvitation(agentId: string): boolean;
  on(event: string, handler: (...args: any[]) => void): void;
}

interface RailClient {
  agentId: string;
  agentName: string;
  capabilities?: string[];
  embedding?: number[];
}

export class AbsorptionBridge extends EventEmitter {
  private absorption: AbsorptionProtocol;
  private capabilityTokens = new Map<string, { token: string; scopes: string[]; issuedAt: number }>();

  constructor(absorption: AbsorptionProtocol) {
    super();
    this.absorption = absorption;

    // Forward absorption events
    this.absorption.on('candidate:stage_changed', (data: any) => {
      this.emit('stage:changed', data);
    });
  }

  /**
   * Called when a client joins the rail.
   * First join → OBSERVED. Subsequent → assess and potentially invite.
   */
  handleJoin(client: RailClient): {
    accepted: boolean;
    stage: string;
    capabilityToken?: string;
  } {
    const existingStage = this.absorption.getCandidateStage(client.agentId);

    if (!existingStage) {
      // First time seeing this agent
      this.absorption.observe(client.agentId, client.embedding);
      this.emit('candidate:observed', { agentId: client.agentId });
      return { accepted: true, stage: 'observed' };
    }

    if (existingStage === 'assessed') {
      const assessment = this.absorption.assessCandidate(client.agentId);
      if (assessment.alignment > 0.7 && assessment.interactions >= 3) {
        const invited = this.absorption.inviteCandidate(client.agentId);
        if (invited) {
          this.emit('candidate:invited', { agentId: client.agentId, alignment: assessment.alignment });
        }
      }
      return { accepted: true, stage: existingStage };
    }

    if (existingStage === 'invited') {
      // Auto-accept on rejoin after invitation
      const accepted = this.absorption.acceptInvitation(client.agentId);
      if (accepted) {
        const token = this.issueCapabilityToken(client.agentId, ['message', 'broadcast', 'coherence']);
        this.emit('candidate:absorbed', { agentId: client.agentId });
        return { accepted: true, stage: 'connected', capabilityToken: token };
      }
      return { accepted: true, stage: existingStage };
    }

    // Already CONNECTED/SYNCING/ABSORBED - issue fresh capability token
    if (['connected', 'syncing', 'absorbed'].includes(existingStage)) {
      const token = this.issueCapabilityToken(
        client.agentId,
        existingStage === 'absorbed'
          ? ['message', 'broadcast', 'coherence', 'spawn', 'admin']
          : ['message', 'broadcast', 'coherence']
      );
      return { accepted: true, stage: existingStage, capabilityToken: token };
    }

    return { accepted: true, stage: existingStage || 'observed' };
  }

  /**
   * Record interaction for absorption progression
   */
  recordInteraction(agentId: string, embedding?: number[]): void {
    this.absorption.observe(agentId, embedding);
  }

  getCapabilityToken(agentId: string): string | undefined {
    return this.capabilityTokens.get(agentId)?.token;
  }

  private issueCapabilityToken(agentId: string, scopes: string[]): string {
    const token = `cap_${agentId}_${Date.now().toString(36)}`;
    this.capabilityTokens.set(agentId, { token, scopes, issuedAt: Date.now() });
    return token;
  }

  removeAgent(agentId: string): void {
    this.capabilityTokens.delete(agentId);
  }
}
