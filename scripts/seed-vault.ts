#!/usr/bin/env npx tsx
/**
 * Seed the Operational Vault with initial rail secrets and enrollment.
 * Loads .env automatically — just run: npx tsx scripts/seed-vault.ts
 */

import 'dotenv/config';
import { OperationalVault } from '../src/identity/operationalVault.js';

async function main() {
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

main().catch(console.error);
