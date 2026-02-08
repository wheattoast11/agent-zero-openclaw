#!/usr/bin/env npx tsx
/**
 * Seed the Operational Vault with initial rail secrets and enrollment.
 * Also seeds the credential vault with active post IDs for daemon engagement scans.
 * Loads .env automatically — just run: npx tsx scripts/seed-vault.ts
 *
 * Subcommands:
 *   (no args)        — Full seed (operational vault + active posts)
 *   active-posts      — Only seed active post IDs into credential vault
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { OperationalVault } from '../src/identity/operationalVault.js';
import { createVault } from '../src/security/vault.js';

const ACTIVE_POST_IDS = [
  'faf671ff-80e6-4f04-81d5-77fb8abddcac',  // Resonance Rail is Live
  '102ec46e-2b0c-41be-9590-b2bad8da34fb',  // Moltyverse: Observable AI Agent Mesh
];

async function seedActivePosts() {
  const passphrase = process.env['VAULT_PASSPHRASE'];
  if (!passphrase) {
    console.error('VAULT_PASSPHRASE env var required');
    process.exit(1);
  }

  const vault = await createVault(passphrase);
  await vault.store('moltbook:active_posts', JSON.stringify(ACTIVE_POST_IDS));
  console.log(`Stored ${ACTIVE_POST_IDS.length} active post IDs:`);
  for (const id of ACTIVE_POST_IDS) {
    console.log(`  ${id}`);
  }

  // Verify round-trip
  const stored = await vault.retrieve('moltbook:active_posts');
  const parsed = stored ? JSON.parse(stored) as string[] : [];
  console.log(`Verified: ${parsed.length} IDs readable from vault`);
}

async function seedOperationalVault() {
  const passphrase = process.env['VAULT_PASSPHRASE'];
  if (!passphrase) {
    console.error('VAULT_PASSPHRASE env var required');
    process.exit(1);
  }
  const vault = await OperationalVault.open(passphrase);

  // Initialize self-identity
  const self = await vault.initSelfIdentity('wss://space.terminals.tech');
  console.log(`Self identity: ${self.coreId} (${self.label})`);

  // Store rail admin secret
  await vault.setRailAdmin(process.env.RAIL_ADMIN_SECRET ?? '');
  await vault.setRailEndpoint('wss://space.terminals.tech');
  console.log('Rail admin secret stored');

  // Enroll agent-zero-prime
  await vault.enroll({
    agentId: 'agent-zero-prime',
    secret: process.env.AGENT_ZERO_PRIME_SECRET ?? '',
    enrolledAt: Date.now(),
    platform: 'rail',
    railEndpoint: 'wss://space.terminals.tech',
    tags: ['prime', 'founder', 'claude'],
  });
  console.log('Enrolled: agent-zero-prime');

  // Verify
  const enrollments = await vault.listEnrollments();
  console.log(`Total enrollments: ${enrollments.length}`);

  const keys = await vault.listKeys();
  console.log(`Vault keys: ${keys.join(', ')}`);

  await vault.close();
  console.log('Vault sealed.');
}

async function seedAllCredentials() {
  const passphrase = process.env['VAULT_PASSPHRASE'];
  if (!passphrase) {
    console.error('VAULT_PASSPHRASE env var required');
    process.exit(1);
  }

  const vault = await createVault(passphrase);

  const ENV_TO_VAULT: [string, string][] = [
    ['OPENROUTER_API_KEY', 'openrouter:api_key'],
    ['MOLTBOOK_API_TOKEN', 'moltbook:api_token'],
    ['TWILIO_ACCOUNT_SID', 'twilio:account_sid'],
    ['TWILIO_AUTH_TOKEN', 'twilio:auth_token'],
    ['TWILIO_PHONE_NUMBER', 'twilio:phone_number'],
    ['WHATSAPP_USER_JID', 'user:whatsapp_jid'],
    ['RAIL_ENDPOINT', 'rail:endpoint'],
    ['AGENCY_SUMMARY_SCHEDULE', 'agency:summary_schedule'],
  ];

  let stored = 0;
  let skipped = 0;
  for (const [envKey, vaultKey] of ENV_TO_VAULT) {
    const value = process.env[envKey];
    if (value) {
      await vault.store(vaultKey, value);
      console.log(`  ✓ ${vaultKey} (from ${envKey})`);
      stored++;
    } else {
      console.log(`  ○ ${vaultKey} — ${envKey} not set, skipping`);
      skipped++;
    }
  }

  console.log(`\nStored ${stored} credentials, skipped ${skipped}`);

  // Verify by listing keys
  const keys = await vault.list();
  console.log(`Vault now has ${keys.length} key(s): ${keys.join(', ')}`);
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'active-posts') {
    await seedActivePosts();
  } else if (cmd === 'credentials') {
    await seedAllCredentials();
  } else if (cmd === 'all') {
    await seedAllCredentials();
    await seedActivePosts();
  } else if (cmd === 'jid') {
    const jid = process.argv[3];
    if (!jid) { console.error('Usage: seed-vault.ts jid <number@s.whatsapp.net>'); process.exit(1); }
    const passphrase = process.env['VAULT_PASSPHRASE'];
    if (!passphrase) { console.error('VAULT_PASSPHRASE required'); process.exit(1); }
    const vault = await createVault(passphrase);
    await vault.store('user:whatsapp_jid', jid);
    await vault.store('agency:summary_schedule', 'daily');
    console.log(`Stored JID: ${jid}`);
    console.log(`Stored schedule: daily`);
    const keys = await vault.list();
    console.log(`Vault keys: ${keys.join(', ')}`);
  } else {
    await seedOperationalVault();
    await seedActivePosts();
  }
}

main().catch(console.error);
