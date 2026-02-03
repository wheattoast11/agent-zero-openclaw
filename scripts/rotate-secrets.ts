#!/usr/bin/env npx tsx
/**
 * Rotate HMAC secrets for enrolled agents on the production Resonance Rail.
 * Loads .env automatically — just run: npx tsx scripts/rotate-secrets.ts
 *
 * Options:
 *   --dry-run       Show what would happen without making changes
 *   --upload-vault  Upload vault.enc to Fly.io agency after rotation
 *   --rail-url      Override rail URL (default: https://space-terminals-tech.fly.dev)
 */

import 'dotenv/config';
import { randomBytes } from 'crypto';
import { OperationalVault } from '../src/identity/operationalVault.js';

const AGENTS = [
  { agentId: 'agent-zero-prime', tags: ['prime', 'founder', 'claude'] },
  { agentId: 'agent-zero-observer', tags: ['observer', 'moltyverse'] },
];

const DEFAULT_RAIL_URL = 'https://space-terminals-tech.fly.dev';

async function main() {
  const passphrase = process.env['VAULT_PASSPHRASE'];
  const adminSecret = process.env['RAIL_ADMIN_SECRET'];
  const dryRun = process.argv.includes('--dry-run');
  const uploadVault = process.argv.includes('--upload-vault');
  const railUrlArg = process.argv.find(a => a.startsWith('--rail-url='));
  const railUrl = railUrlArg?.split('=')[1] || DEFAULT_RAIL_URL;

  if (!passphrase) {
    console.error('VAULT_PASSPHRASE env var required');
    process.exit(1);
  }
  if (!adminSecret) {
    console.error('RAIL_ADMIN_SECRET env var required');
    process.exit(1);
  }

  console.log(`Rail URL: ${railUrl}`);
  console.log(`Agents:   ${AGENTS.map(a => a.agentId).join(', ')}`);
  console.log(`Dry run:  ${dryRun}\n`);

  // Generate new secrets
  const rotations = AGENTS.map(agent => ({
    ...agent,
    newSecret: randomBytes(32).toString('hex'),
  }));

  if (dryRun) {
    for (const r of rotations) {
      console.log(`[dry-run] Would rotate ${r.agentId} → ${r.newSecret.slice(0, 8)}...`);
    }
    return;
  }

  // Step 1: Re-enroll on rail
  console.log('Step 1: Re-enrolling on rail...');
  for (const r of rotations) {
    const res = await fetch(`${railUrl}/enroll`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentId: r.agentId, secret: r.newSecret }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`  FAILED ${r.agentId}: ${res.status} ${err}`);
      process.exit(1);
    }

    const data = await res.json();
    console.log(`  ${r.agentId}: enrolled ✓`);
  }

  // Step 2: Update local vault
  console.log('\nStep 2: Updating local vault...');
  const vault = await OperationalVault.open(passphrase);

  for (const r of rotations) {
    await vault.enroll({
      agentId: r.agentId,
      secret: r.newSecret,
      enrolledAt: Date.now(),
      platform: 'rail',
      railEndpoint: 'wss://space.terminals.tech',
      tags: r.tags,
    });
    console.log(`  ${r.agentId}: vault updated ✓`);
  }

  const enrollments = await vault.listEnrollments();
  console.log(`\n  Total enrollments: ${enrollments.length}`);
  await vault.close();

  // Step 3: Optionally upload to Fly
  if (uploadVault) {
    console.log('\nStep 3: Uploading vault to Fly.io agency...');
    const { execSync } = await import('child_process');
    try {
      const home = process.env['HOME'] || '~';
      execSync(
        `fly ssh console -a agent-zero-agency -C "cat > /data/.agent-zero/vault.enc" < ${home}/.agent-zero/vault.enc`,
        { stdio: 'inherit' }
      );
      console.log('  Vault uploaded ✓');
      console.log('  Restarting agency...');
      execSync('fly machine restart -a agent-zero-agency', { stdio: 'inherit' });
      console.log('  Agency restarted ✓');
    } catch (err) {
      console.error('  Upload failed — do it manually:');
      console.error('  fly ssh console -a agent-zero-agency -C "cat > /data/.agent-zero/vault.enc" < ~/.agent-zero/vault.enc');
      console.error('  fly machine restart -a agent-zero-agency');
    }
  } else {
    console.log('\nDone. To deploy to Fly.io, re-run with --upload-vault or manually:');
    console.log('  fly ssh console -a agent-zero-agency -C "cat > /data/.agent-zero/vault.enc" < ~/.agent-zero/vault.enc');
    console.log('  fly machine restart -a agent-zero-agency');
  }

  console.log('\nOld secrets are now invalid. Rotation complete.');
}

main().catch(console.error);
