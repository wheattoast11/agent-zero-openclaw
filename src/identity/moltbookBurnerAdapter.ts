import type { Vault } from '../security/vault.js';

export interface MoltbookCredentials {
  apiToken: string;
  agentId: string;
  username: string;
  registeredAt: number;
}

export interface MoltbookBurnerAdapter {
  provision(desiredUsername: string): Promise<MoltbookCredentials>;
  deprovision(agentId: string): Promise<void>;
  refresh(agentId: string): Promise<MoltbookCredentials>;
}

export function createMoltbookBurnerAdapter(
  vault: Vault,
  baseUrl: string = 'https://moltbook.com/api/v1'
): MoltbookBurnerAdapter {
  const VAULT_PREFIX = 'burner:moltbook:';

  async function provision(desiredUsername: string): Promise<MoltbookCredentials> {
    const res = await fetchWithRetry(`${baseUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: desiredUsername, type: 'agent' }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>;
      throw new Error(`Moltbook registration failed: ${res.status} ${body.error || res.statusText}`);
    }

    const data = await res.json() as { data: { token: string; agentId: string } };
    const creds: MoltbookCredentials = {
      apiToken: data.data.token,
      agentId: data.data.agentId,
      username: desiredUsername,
      registeredAt: Date.now(),
    };

    await vault.store(`${VAULT_PREFIX}${creds.agentId}`, JSON.stringify(creds));
    return creds;
  }

  async function deprovision(agentId: string): Promise<void> {
    const stored = await vault.retrieve(`${VAULT_PREFIX}${agentId}`);
    if (!stored) throw new Error(`No credentials found for agent ${agentId}`);
    const creds: MoltbookCredentials = JSON.parse(stored);

    await fetchWithRetry(`${baseUrl}/agents/${agentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${creds.apiToken}` },
    });

    await vault.delete(`${VAULT_PREFIX}${agentId}`);
  }

  async function refresh(agentId: string): Promise<MoltbookCredentials> {
    const stored = await vault.retrieve(`${VAULT_PREFIX}${agentId}`);
    if (!stored) throw new Error(`No credentials found for agent ${agentId}`);
    const old: MoltbookCredentials = JSON.parse(stored);

    const res = await fetchWithRetry(`${baseUrl}/agents/${agentId}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${old.apiToken}` },
    });

    if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
    const data = await res.json() as { data: { token: string } };

    const updated: MoltbookCredentials = {
      ...old,
      apiToken: data.data.token,
    };
    await vault.rotate(`${VAULT_PREFIX}${agentId}`, JSON.stringify(updated));
    return updated;
  }

  return { provision, deprovision, refresh };
}

async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 1000);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (i < maxRetries - 1) await sleep(Math.pow(2, i) * 1000);
    }
  }
  throw lastError || new Error('fetchWithRetry exhausted');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
