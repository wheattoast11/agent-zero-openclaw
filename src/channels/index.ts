/**
 * Channel Adapters — unified re-export barrel
 */

export { type ChannelAdapter } from './whatsapp.js';

// WhatsApp + Twilio burner
export { WhatsAppAdapter, createWhatsAppAdapter, TwilioBurnerProvisioner } from './whatsapp.js';
export type { WhatsAppConfig } from './whatsapp.js';

// Telegram
export { TelegramAdapter, createTelegramAdapter } from './telegram.js';
export type { TelegramConfig } from './telegram.js';

// Twitter/X
export { TwitterAdapter, createTwitterAdapter } from './twitter.js';
export type { TwitterConfig, TwitterMention } from './twitter.js';

// Moltbook
export { MoltbookAdapter, createMoltbookAdapter } from './moltbook.js';
export type { MoltbookConfig, MoltbookPost, MoltbookComment, MoltbookFeedItem } from './moltbook.js';
