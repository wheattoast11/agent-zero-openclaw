/**
 * @terminals-tech/agent-zero/runtime
 *
 * Full 24/7 agency runtime — daemon, channels, engagement.
 */

// Agency runtime
export { AgencyRuntime, startAgency } from '../agency/runtime.js';
export { CommandRouter, createCommandRouter } from '../agency/commandRouter.js';
export { SummaryScheduler, createSummaryScheduler } from '../agency/summaryScheduler.js';
export { collectSummaryData, formatWhatsApp, formatMarkdown } from '../agency/summaryGenerator.js';

// Session persistence
export { InMemorySessionStore, FileSessionStore } from './sessionStore.js';
export type { SessionStore, SessionSnapshot } from './sessionStore.js';

// Context window management
export { ContextWindow } from './contextWindow.js';
export type { ContextWindowConfig } from './contextWindow.js';

// Identity prompt architecture
export { IdentityPromptBuilder, createAgentZeroIdentity } from './identity.js';
export type { IdentitySection, IdentityConfig, IdentityContext } from './identity.js';

// Channel adapters
export { WhatsAppAdapter, createWhatsAppAdapter } from '../channels/whatsapp.js';
export { TelegramAdapter, createTelegramAdapter } from '../channels/telegram.js';
export { MoltbookAdapter, createMoltbookAdapter } from '../channels/moltbook.js';
