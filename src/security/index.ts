/**
 * @terminals-tech/agent-zero/security
 *
 * AES-256-GCM vault, capability sandbox, injection firewall, Ed25519 skill verification,
 * capability combinators, agent isolation boundaries.
 */

export { Vault, createVault } from './vault.js';
export { IsomorphicSandbox, CapabilityScope, detectInjection, generateCapabilityToken } from './sandbox.js';
export type { AuditEntry } from './sandbox.js';
export { SkillCapabilityManager, createSkillCapabilityManager } from './capabilities.js';
export { InjectionFirewall, ParanoiaLevel, createFirewall } from './injectionFirewall.js';
export {
  generateSigningKeyPair,
  signManifest,
  verifyManifest,
  verifySkillIntegrity,
  createManifest,
  hashFile,
  loadSignedManifest,
} from './skillVerify.js';
export {
  read,
  write,
  network,
  execute,
  memory,
  spawn,
  combine,
  restrict,
  withTTL,
  materialize,
  PROFILES,
} from './combinators.js';
export type { CapabilityExpression } from './combinators.js';
export { AgentIsolationManager } from './isolation.js';
export type { IsolationBoundary } from './isolation.js';
