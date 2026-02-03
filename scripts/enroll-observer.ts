import 'dotenv/config';
import { OperationalVault } from '../src/identity/operationalVault.js';

async function main() {
  const passphrase = process.env['VAULT_PASSPHRASE'];
  const secret = process.env['OBSERVER_SECRET'];
  if (!passphrase || !secret) {
    console.error('Required: VAULT_PASSPHRASE, OBSERVER_SECRET');
    process.exit(1);
  }
  const vault = await OperationalVault.open(passphrase);
  await vault.enroll({
    agentId: 'agent-zero-observer',
    secret,
    enrolledAt: Date.now(),
    platform: 'rail',
    railEndpoint: 'wss://space.terminals.tech',
    tags: ['observer', 'moltyverse'],
  });
  const enrollments = await vault.listEnrollments();
  console.log('Enrollments:', enrollments.map(e => e.agentId));
  const self = await vault.getSelfIdentity();
  console.log('Self:', self?.coreId, '| enrolled:', self?.enrolledAgents);
  await vault.close();
}
main().catch(console.error);
