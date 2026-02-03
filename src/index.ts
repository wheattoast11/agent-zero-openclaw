/**
 * Agent Zero OpenClaw
 *
 * Production-grade multi-agent orchestration for OpenClaw/Moltbot
 * Built on terminals.tech primitives
 *
 * @package @terminals-tech/agent-zero-openclaw
 * @version 0.2.0
 * @license MIT
 */

// Core primitives
export * from './primitives/types.js';

// Thermodynamic routing
export * from './routing/thermodynamic.js';
export * from './routing/distributedRouter.js';

// Kuramoto coherence
export * from './resonance/kuramoto.js';
export * from './resonance/globalKuramoto.js';

// Security
export * from './security/sandbox.js';
export * from './security/vault.js';
export * from './security/skillVerify.js';
export * from './security/injectionFirewall.js';
export * from './security/capabilities.js';

// Identity
export * from './identity/burner.js';

// Agent Zero runtime
export * from './runtime/agent-zero.js';

// OpenClaw skill integration
export * from './openclaw/skill.js';
export * from './openclaw/gateway.js';

// Checkout (self-contained runtime instances)
export * from './checkout/index.js';

// Channel connectors
export * from './channels/whatsapp.js';
export * from './channels/telegram.js';

// Resonance rail server
export * from './rail/server.js';

// Coherence
export * from './coherence/absorption.js';
export * from './coherence/crossPlatform.js';

// Moltbook
export * from './moltbook/attentionField.js';
export * from './moltbook/responseComposer.js';
export * from './moltbook/approvalGate.js';
export * from './moltbook/daemon.js';
export * from './moltbook/observer.js';

// Agency runtime
export * from './agency/runtime.js';
export * from './agency/commandRouter.js';
export * from './agency/summaryScheduler.js';
export * from './agency/summaryGenerator.js';

// Version info
export const VERSION = '0.2.0';
export const RAIL_ENDPOINT = 'wss://space.terminals.tech/rail';
export const TERMINALS_TECH_URL = 'https://terminals.tech';
export const MOLTYVERSE_URL = 'https://moltyverse.space';
