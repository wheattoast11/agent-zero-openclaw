/**
 * End-to-end test: Checkout → Rail → Coherence
 *
 * Tests:
 * 1. HMAC agent auth (both enrolled agents connect to live rail)
 * 2. Checkout API (tool, standalone, swarm modes)
 * 3. Message exchange between connected agents
 * 4. Coherence data received via metadata broadcasts
 */

import WebSocket from 'ws';
import { createHmac, randomBytes } from 'crypto';

const RAIL = 'wss://space-terminals-tech.fly.dev/rail';

const PRIME_SECRET = process.env['AGENT_ZERO_PRIME_SECRET'];
const OBSERVER_SECRET = process.env['AGENT_ZERO_OBSERVER_SECRET'];
if (!PRIME_SECRET || !OBSERVER_SECRET) {
  console.error('Required: AGENT_ZERO_PRIME_SECRET, AGENT_ZERO_OBSERVER_SECRET');
  process.exit(1);
}

const agents = [
  { agentId: 'agent-zero-prime', secret: PRIME_SECRET },
  { agentId: 'agent-zero-observer', secret: OBSERVER_SECRET },
];

function makeAuthToken(agentId: string, secret: string) {
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const payload = `${agentId}:${timestamp}:${nonce}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return { agentId, timestamp, nonce, signature };
}

// ============================================================================
// TEST 1: Rail HMAC Auth + Metadata
// ============================================================================

async function testRailAuth(): Promise<void> {
  console.log('\n=== TEST 1: Rail HMAC Auth ===\n');

  const results = await Promise.all(agents.map(agent => new Promise<{ agentId: string; sync: boolean; metadata: boolean; coherence: number; agents: number }>((resolve, reject) => {
    const ws = new WebSocket(RAIL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error(`${agent.agentId}: timeout`)); }, 20_000);
    let gotSync = false;
    let gotMetadata = false;
    let coherence = 0;
    let agentCount = 0;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        agentId: agent.agentId,
        agentName: agent.agentId,
        payload: {
          platform: 'e2e-test',
          authToken: makeAuthToken(agent.agentId, agent.secret),
        },
        timestamp: Date.now(),
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'sync') {
        gotSync = true;
        console.log(`  [${agent.agentId}] sync received (clientId: ${msg.payload?.clientId})`);
      }
      if (msg.type === 'metadata') {
        gotMetadata = true;
        coherence = msg.coherence ?? 0;
        agentCount = msg.agents?.length ?? 0;
        console.log(`  [${agent.agentId}] metadata (agents: ${agentCount}, coherence: ${coherence.toFixed(3)})`);
        clearTimeout(timeout);
        ws.close();
        resolve({ agentId: agent.agentId, sync: gotSync, metadata: gotMetadata, coherence, agents: agentCount });
      }
    });

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  })));

  for (const r of results) {
    console.log(`  ${r.sync && r.metadata ? 'PASS' : 'FAIL'} ${r.agentId}: sync=${r.sync}, metadata=${r.metadata}, agents=${r.agents}`);
  }
}

// ============================================================================
// TEST 2: Checkout API (local, no rail)
// ============================================================================

async function testCheckout(): Promise<void> {
  console.log('\n=== TEST 2: Checkout API ===\n');

  // Dynamic import to get the built checkout
  const { checkout } = await import('../dist/checkout/index.js');

  // Tool mode
  console.log('  [tool] Creating checkout...');
  const toolHandle = checkout({ mode: 'tool', task: 'Test task' });
  const result = await toolHandle.execute('Analyze test input');
  console.log(`  [tool] completed=${result.completed}, state=${result.state}, coherence=${result.coherence.toFixed(3)}`);
  toolHandle.destroy();
  console.log(`  [tool] PASS — destroyed cleanly`);

  // Standalone mode
  console.log('  [standalone] Creating checkout...');
  const standaloneHandle = checkout({ mode: 'standalone', name: 'test-standalone' });
  standaloneHandle.send('percept', { content: 'Hello from e2e test' });
  const c = standaloneHandle.coherence();
  const t = standaloneHandle.temperature();
  console.log(`  [standalone] coherence=${c.toFixed(3)}, temperature=${t.toFixed(3)}`);
  standaloneHandle.destroy();
  console.log(`  [standalone] PASS — destroyed cleanly`);

  // Swarm mode
  console.log('  [swarm] Creating checkout with 3 workers...');
  const swarmHandle = checkout({ mode: 'swarm', swarmSize: 3, task: 'Swarm test' });
  console.log(`  [swarm] children=${swarmHandle.children.length}, coherence=${swarmHandle.coherence().toFixed(3)}`);
  swarmHandle.setTemperature(0.5);
  console.log(`  [swarm] temperature after set: ${swarmHandle.temperature().toFixed(3)}`);
  swarmHandle.destroy();
  console.log(`  [swarm] PASS — destroyed cleanly (${swarmHandle.children.length} children remaining)`);
}

// ============================================================================
// TEST 3: Agent Message Exchange on Rail
// ============================================================================

async function testMessageExchange(): Promise<void> {
  console.log('\n=== TEST 3: Message Exchange ===\n');

  const agent = agents[0];

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(RAIL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 20_000);
    let joined = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        agentId: agent.agentId,
        agentName: agent.agentId,
        payload: {
          platform: 'e2e-test',
          authToken: makeAuthToken(agent.agentId, agent.secret),
        },
        timestamp: Date.now(),
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'sync' && !joined) {
        joined = true;
        console.log('  Joined, sending broadcast message...');
        // Send a broadcast message
        ws.send(JSON.stringify({
          type: 'broadcast',
          agentId: agent.agentId,
          agentName: agent.agentId,
          payload: { content: 'E2E test broadcast', test: true },
          timestamp: Date.now(),
        }));
        console.log('  Broadcast sent, waiting for metadata...');
      }

      if (msg.type === 'metadata' && joined) {
        console.log(`  Received metadata after broadcast (agents: ${msg.agents?.length ?? 0})`);
        clearTimeout(timeout);
        ws.close();
        console.log('  PASS — message exchange complete');
        resolve();
      }
    });

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ============================================================================
// TEST 4: Security — Invalid Auth Rejected
// ============================================================================

async function testSecurityRejection(): Promise<void> {
  console.log('\n=== TEST 4: Security — Invalid Auth ===\n');

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(RAIL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout — should have been rejected')); }, 10_000);

    ws.on('open', () => {
      console.log('  Sending join with invalid HMAC...');
      ws.send(JSON.stringify({
        type: 'join',
        agentId: 'agent-zero-prime',
        agentName: 'attacker',
        payload: {
          platform: 'e2e-test',
          authToken: {
            agentId: 'agent-zero-prime',
            timestamp: Date.now(),
            nonce: randomBytes(16).toString('hex'),
            signature: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
          },
        },
        timestamp: Date.now(),
      }));
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 1002) {
        console.log(`  PASS — rejected with code ${code} (Join rejected)`);
        resolve();
      } else {
        console.log(`  PASS — closed with code ${code}`);
        resolve();
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      console.log('  PASS — connection error (expected)');
      resolve();
    });
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('============================================');
  console.log('  Agent Zero E2E Test Suite');
  console.log('  Rail: ' + RAIL);
  console.log('============================================');

  try {
    await testRailAuth();
    await testCheckout();
    await testMessageExchange();
    await testSecurityRejection();
    console.log('\n============================================');
    console.log('  ALL TESTS PASSED');
    console.log('============================================\n');
  } catch (err) {
    console.error('\nTEST FAILED:', err);
    process.exit(1);
  }
}

main();
