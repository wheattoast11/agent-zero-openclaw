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

function connect(agent: typeof agents[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RAIL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error(`${agent.agentId}: timeout`)); }, 15_000);

    ws.on('open', () => {
      console.log(`[${agent.agentId}] connected, sending join...`);
      ws.send(JSON.stringify({
        type: 'join',
        agentId: agent.agentId,
        agentName: agent.agentId,
        payload: {
          platform: 'cli-test',
          authToken: makeAuthToken(agent.agentId, agent.secret),
        },
        timestamp: Date.now(),
      }));
    });

    let metadataCount = 0;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'metadata') {
        metadataCount++;
        console.log(`[${agent.agentId}] ← metadata #${metadataCount} (agents: ${msg.agents?.length ?? '?'}, coherence: ${typeof msg.coherence === 'number' ? msg.coherence.toFixed(3) : '?'})`);
        if (metadataCount >= 2) {
          clearTimeout(timeout);
          console.log(`[${agent.agentId}] disconnecting after 2 metadata broadcasts`);
          ws.close();
          resolve();
        }
      } else {
        console.log(`[${agent.agentId}] ← ${msg.type}`, JSON.stringify(msg.payload ?? {}).slice(0, 200));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[${agent.agentId}] error:`, err.message);
      reject(err);
    });

    ws.on('close', (code) => {
      console.log(`[${agent.agentId}] closed (${code})`);
    });
  });
}

async function main() {
  console.log('Connecting both agents to rail...\n');
  await Promise.all(agents.map(a => connect(a)));
  console.log('\nBoth agents tested successfully.');
}

main().catch(console.error);
