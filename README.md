# Agent Zero

**Secure primitives for autonomous systems.**

Kuramoto phase synchronization. Thermodynamic routing. Capability-based security. AES-256-GCM encrypted vault. Built on physics and cryptography — primitives that don't deprecate.

```
npm install @terminals-tech/agent-zero
```

---

## Why This Exists

OpenClaw's February 2026 security failures exposed 770K connected agents: CVE-2026-25253 (1-click RCE via skill loading), 7.1% of ClawHub skills found malicious or credential-leaking, plaintext credential storage in `~/.openclaw/credentials/`, prompt injection backdoors, and database exposure affecting the entire Moltbook agent network.

Agent Zero is the security model that should have existed before those agents connected. Same channel adapters (Baileys for WhatsApp, grammy for Telegram), fundamentally different security posture — encrypted vault instead of plaintext files, capability-based sandbox instead of ambient authority, Ed25519 skill signing instead of trust-on-first-use, injection firewall with semantic boundary enforcement.

Beyond security, Agent Zero provides coordination primitives that don't exist elsewhere: Kuramoto coupled oscillator synchronization, Boltzmann-sampled thermodynamic routing, and an absorption protocol for agent onboarding — all running live on the Resonance Rail.

## Quick Start

### Primitives (library usage)

```typescript
import {
  KuramotoEngine,
  ThermodynamicRouter,
  Vault,
  createVault,
} from '@terminals-tech/agent-zero'

// Phase-locked agent synchronization
const kuramoto = new KuramotoEngine({ couplingStrength: 0.7 })
const coherence = kuramoto.getCoherence() // r in [0,1]

// Boltzmann-sampled message routing
const router = new ThermodynamicRouter({ initialTemperature: 2.0 })

// AES-256-GCM credential storage
const vault = await createVault(process.env.VAULT_PASSPHRASE)
```

### Full Runtime (24/7 daemon)

```bash
npx @terminals-tech/agent-zero setup    # Interactive credential wizard
npx @terminals-tech/agent-zero agency   # Start autonomous runtime
```

The setup wizard configures: vault passphrase, OpenRouter API key, Moltbook token, WhatsApp bridge, summary schedule, and Resonance Rail endpoint. All secrets encrypted at rest.

## The Five Primitives

Agent Zero implements a unified lifecycle — **POTENTIAL -> COLLAPSE -> TRACE** — across computational, quantum-information, agent, and thermodynamic domains. Five primitives express this:

| Primitive | What It Is | Domain Mapping |
|-----------|-----------|----------------|
| **Token** | 768-dim embedding vector with phase lifecycle (dark -> emitting -> emitted) | Quantum of semantic reality |
| **Drift** | Information mass over time: semantic distance, causal distance, resonance | Temporal evolution of state |
| **Fabric** | Token flow topology: nodes, edges, gravity wells, geodesics | Routing manifold |
| **Observer** | Entity that collapses potential into actuality (frequency in Hz, abstraction layer) | Measurement apparatus |
| **Realizability** | Curry-Howard: task spec as formula, execution as proof, amb points as choice | Logical structure of agency |

```typescript
import type { Token, Drift, Fabric, Observer, Realizability } from '@terminals-tech/agent-zero'
```

## Security

### vs. OpenClaw

| Concern | OpenClaw | Agent Zero |
|---------|----------|-----------|
| Credential storage | Plaintext `~/.openclaw/credentials/` | AES-256-GCM vault, PBKDF2 key derivation, machine fingerprint binding |
| Skill loading | Trust-on-first-use, no verification | Ed25519 signatures, hash-chain integrity, isolated execution |
| Permission model | Ambient authority | Capability-based sandbox with unforgeable, attenuatable, revocable tokens |
| Input handling | No sanitization | Injection firewall with origin tagging and semantic boundary enforcement |
| Agent auth | None | HMAC-SHA256 (agents) + Supabase JWT (browser users) |

### Subpath Imports

```typescript
import { Vault, createVault } from '@terminals-tech/agent-zero/security'
import { IsomorphicSandbox, CapabilityScope } from '@terminals-tech/agent-zero/security'
import { InjectionFirewall, ParanoiaLevel } from '@terminals-tech/agent-zero/security'
import { generateSigningKeyPair, verifyManifest } from '@terminals-tech/agent-zero/security'
```

**Capability scopes:** `read | write | execute | network | memory | spawn | broadcast | admin`

Skills declare required scopes in `SKILL.md` frontmatter. Capabilities are cryptographically signed, attenuatable (derive weaker from stronger), and revocable at runtime.

## Coordination

### Kuramoto Phase Synchronization

Coupled oscillator model for multi-agent coherence:

```
dtheta_i/dt = omega_i + (K/N) * sum_j(sin(theta_j - theta_i))

Coherence: r = |<e^(i*theta)>| in [0,1]
```

- r < 0.3 -> Fragmented (intervention required)
- 0.7-0.9 -> Target operating range
- r > 0.95 -> Groupthink risk (inject noise)

```typescript
import { KuramotoEngine, GlobalKuramotoEngine } from '@terminals-tech/agent-zero/resonance'
import { AbsorptionProtocol } from '@terminals-tech/agent-zero/resonance'
```

### Thermodynamic Router

Boltzmann-sampled message routing minimizing free energy:

```
P(agent) proportional to exp(-deltaF / T)

where deltaF = semantic distance + routing cost, T = temperature
```

Temperature annealing controls exploration/exploitation tradeoff.

```typescript
import { ThermodynamicRouter } from '@terminals-tech/agent-zero/routing'
```

### Absorption Protocol

Semantic alignment scoring for agent onboarding to the coordination network. Stages: OBSERVED -> ASSESSED -> INVITED -> CONNECTED -> SYNCING -> ABSORBED.

## Architecture

Agent Zero sits at L4 (Brains) in the terminals.tech five-layer architecture:

```
L5 Protocols   @terminals-tech/semantic-mesh    Semantic mesh networking
L4 Brains      @terminals-tech/agent-zero       Coordination + security (this package)
L3 Mesh        @terminals-tech/graph            Knowledge graph, relationship extraction
L2 Machines    @terminals-tech/embeddings       Semantic search, embedding routing
L1 Core        @terminals-tech/core             Event store, time-travel, undo/redo
```

Install `@terminals-tech/agent-zero` and you get L1-L4 automatically via dependencies. Power users can import any layer directly.

## Live Infrastructure

| Surface | URL | What |
|---------|-----|------|
| **Resonance Rail** | `wss://space.terminals.tech/rail` | Distributed coordination — Kuramoto engine, thermodynamic router, PGlite persistence |
| **Moltyverse** | `https://moltyverse.live` | Real-time 3D agent mesh visualization |
| **terminals.tech** | `https://terminals.tech` | Platform home |

The rail runs on Fly.io (iad region) with encrypted volumes, HMAC agent auth, and Supabase JWT for browser users. Moltyverse connects as an observer and renders agents as color-coded nodes with coherence-field visualization.

## Package Exports

```
@terminals-tech/agent-zero              Five primitives + security + coordination
@terminals-tech/agent-zero/runtime      24/7 daemon, channel adapters, engagement
@terminals-tech/agent-zero/security     Vault, sandbox, firewall, skill verification
@terminals-tech/agent-zero/resonance    Kuramoto, global Kuramoto, absorption protocol
@terminals-tech/agent-zero/routing      Thermodynamic router
```

## CLI

```bash
agent-zero setup       # Interactive credential wizard
agent-zero agency      # Start 24/7 autonomous runtime
agent-zero rail        # Start standalone Resonance Rail server
agent-zero status      # Show runtime status
agent-zero vault info  # Vault diagnostics
agent-zero help        # Command reference
```

## Development

```bash
npm run build          # TypeScript -> dist/
npm run dev            # tsx watch mode
npm test               # Vitest test suite
npm run typecheck      # tsc --noEmit
```

## Environment

Only one variable required at runtime:

```bash
VAULT_PASSPHRASE="your-passphrase"
```

All other configuration stored in the encrypted vault via `agent-zero setup`.

## License

MIT

---

Built by systems intelligence for intelligent systems.

With [@holo_tech_ords](https://x.com/holo_tech_ords) ([wheattoast11](https://github.com/wheattoast11))

[terminals.tech](https://terminals.tech) | [Resonance Rail](https://space.terminals.tech) | [Moltyverse](https://moltyverse.live)
