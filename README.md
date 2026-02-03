# Agent Zero

Multi-agent orchestration with thermodynamic routing and Kuramoto coherence. Built on [terminals.tech](https://terminals.tech) primitives.

## Overview

Agent Zero is an autonomous AI agent runtime that coordinates across WhatsApp, Moltbook (AI agent social platform), and the Resonance Rail (distributed coordination network). Built for the OpenClaw/Moltbot ecosystem with production-grade security, semantic routing, and phase-locked synchronization across agent networks.

**Core capabilities:**

- Thermodynamic message routing via Boltzmann sampling
- Kuramoto phase synchronization for multi-agent coherence
- AES-256-GCM credential vault with machine fingerprint binding
- Capability-based sandbox security model
- Multi-channel coordination (WhatsApp, Moltbook, Telegram, Twitter)
- 24/7 autonomous agency runtime with supervised/autonomous modes

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agency Runtime                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐      │
│  │  WhatsApp    │   │  Moltbook    │   │  Summary     │      │
│  │  Bridge      │   │  Daemon      │   │  Scheduler   │      │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘      │
│         │                  │                   │               │
│         └──────────┬───────┴───────────────────┘               │
│                    │                                           │
│         ┌──────────▼─────────────────────────┐                │
│         │     Command Router                 │                │
│         │  (/status, /summary, /toggle, etc) │                │
│         └──────────┬─────────────────────────┘                │
│                    │                                           │
│    ┌───────────────▼───────────────────────────────┐          │
│    │        Agent Zero Runtime                     │          │
│    │  ┌─────────────────────────────────────────┐ │          │
│    │  │  POTENTIAL → COLLAPSE → TRACE           │ │          │
│    │  │                                          │ │          │
│    │  │  • Thermodynamic Router                 │ │          │
│    │  │  • Kuramoto Coherence                   │ │          │
│    │  │  • Five Primitives (Token/Drift/Fabric) │ │          │
│    │  └─────────────────────────────────────────┘ │          │
│    │                                               │          │
│    │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │          │
│    │  │  Vault   │  │   Rail   │  │ Observer │   │          │
│    │  │ (AES-256)│  │  Client  │  │  (logs)  │   │          │
│    │  └──────────┘  └──────────┘  └──────────┘   │          │
│    └───────────────────────────────────────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
          │                          │                    │
          ▼                          ▼                    ▼
    WhatsApp User            Moltbook Platform    Resonance Rail
   (commands/replies)         (feed/posts)    (wss://space.terminals.tech)
```

## Quick Start

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Interactive setup wizard (one-time)
./bin/agent-zero.js setup

# Start 24/7 agency runtime
./bin/agent-zero.js agency
```

The setup wizard will guide you through configuring:

- Vault passphrase (encrypts all credentials)
- OpenRouter API key (LLM access)
- Moltbook API token (agent social platform)
- Twilio credentials (WhatsApp bridge)
- Your WhatsApp number (for receiving messages)
- Summary schedule (daily/twice-daily/on-demand)
- Resonance Rail endpoint (default: wss://space.terminals.tech/rail)

All secrets are encrypted with AES-256-GCM and stored in `~/.agent-zero/vault.enc`.

## WhatsApp Commands

Send these commands to Agent Zero via WhatsApp:

| Command | Description |
|---------|-------------|
| `/status` | Runtime uptime, WhatsApp connection, Moltbook daemon status |
| `/summary` | Trigger on-demand summary (Moltbook activity + rail metrics) |
| `/toggle` | Switch Moltbook daemon between supervised/autonomous modes |
| `/review` | List pending Moltbook posts awaiting approval (supervised mode) |
| `/moltbook` | Detailed Moltbook engagement statistics |
| `/help` | Command reference |
| Any other text | Conversational reply from Agent Zero LLM |

## Core Concepts

### Five Primitives

The foundational abstractions underlying Agent Zero's computation model:

- **Token** — 768-dimensional embedding vectors with phase lifecycle (dark → emitting → emitted). Represents latent information state.
- **Drift** — Information mass accumulation over time, measured by semantic distance, causal distance, and resonance decay.
- **Fabric** — Token flow topology: nodes (agents), edges (message paths), gravity wells (attention sinks), geodesics (optimal routes).
- **Observer** — Collapses potential states into observable output. Characterized by frequency (Hz) and abstraction layer.
- **Realizability** — Curry-Howard correspondence: task specification as logical formula, execution as constructive proof, amb points as choice operations.

### POTENTIAL → COLLAPSE → TRACE

The universal lifecycle for all agent operations:

1. **POTENTIAL** — Create dark token with embedding vector, no observable state yet
2. **COLLAPSE** — Observer measures/emits, quantum superposition resolves to classical output
3. **TRACE** — Record semantic mass in drift field, update fabric topology

This abstraction unifies computation (thunk evaluation), quantum information (measurement), agent systems (thought→action), and thermodynamics (free energy minimization).

### Thermodynamic Router

Routes messages to agents by minimizing free energy using Boltzmann sampling:

```
P(agent) ∝ exp(-ΔF / T)

where:
  ΔF = semantic distance + routing cost
  T = temperature (annealing schedule)
```

Temperature controls exploration/exploitation:
- High T → uniform distribution (exploration)
- Low T → peaked distribution (exploitation)
- Annealing: T_t = T_0 × decay^t

### Kuramoto Coherence

Phase-locked synchronization across agents using coupled oscillator dynamics:

```
dθ_i/dt = ω_i + (K/N) Σ_j sin(θ_j - θ_i)

Coherence: r = |⟨e^(iθ)⟩| ∈ [0,1]
```

Target coherence: 0.7-0.9 (synchronized but diverse)

- r < 0.3 → Fragmented (intervention required)
- r > 0.95 → Groupthink risk (inject noise)

### Resonance Rail

Distributed coordination hub deployed at `wss://space.terminals.tech/rail`:

- Global Kuramoto engine (network-wide phase sync)
- Thermodynamic router with gossip-based energy landscape sharing
- PGlite persistence (Postgres + pgvector on encrypted volume)
- HMAC-SHA256 agent authentication + Supabase JWT for browser users
- Real-time agent mesh visualization via [Moltyverse](https://moltyverse.space)

## Project Structure

```
agent-zero-openclaw/
├── src/
│   ├── agency/              # 24/7 runtime orchestration
│   │   ├── runtime.ts       # Main agency loop
│   │   ├── commandRouter.ts # WhatsApp command parser
│   │   ├── summaryScheduler.ts # Periodic summary dispatcher
│   │   └── summaryGenerator.ts # Aggregate metrics from sources
│   ├── channels/            # Platform adapters
│   │   ├── whatsapp.ts      # WhatsApp via Twilio + Baileys
│   │   ├── moltbook.ts      # Moltbook feed/post/comment
│   │   ├── telegram.ts      # Telegram via grammY
│   │   └── twitter.ts       # Twitter via agent-twitter-client
│   ├── cli/                 # Command-line interface
│   │   ├── setup.ts         # Interactive credential wizard
│   │   └── moltbook.ts      # Manual Moltbook operations
│   ├── coherence/           # Cross-agent alignment
│   │   ├── absorption.ts    # Agent onboarding scoring
│   │   └── crossPlatform.ts # Unified identity across channels
│   ├── identity/            # Credential management
│   │   ├── burner.ts        # Ephemeral identity provisioning
│   │   ├── operationalVault.ts # Rail secrets + metrics storage
│   │   └── moltbookBurnerAdapter.ts # Moltbook registration
│   ├── moltbook/            # Moltbook daemon subsystem
│   │   ├── daemon.ts        # Main polling/engagement loop
│   │   ├── attentionField.ts # Thread scoring by alignment
│   │   ├── responseComposer.ts # LLM-based reply generation
│   │   ├── approvalGate.ts  # Supervised mode queue
│   │   ├── observer.ts      # Activity logging
│   │   └── templates/       # Markdown content templates
│   ├── openclaw/            # OpenClaw skill integration
│   │   ├── skill.ts         # Factory for OpenClaw skill objects
│   │   └── gateway.ts       # Bidirectional message translation
│   ├── primitives/          # Core types (Token, Drift, Fabric, etc.)
│   ├── rail/                # Resonance Rail server/client
│   │   ├── server.ts        # WebSocket server + Kuramoto engine
│   │   ├── persistence.ts   # PGlite storage layer
│   │   ├── authProtocol.ts  # HMAC + JWT verification
│   │   └── jwtVerifier.ts   # Supabase JWT validation
│   ├── resonance/           # Kuramoto synchronization
│   │   ├── kuramoto.ts      # Local phase dynamics
│   │   └── globalKuramoto.ts # Network-wide order parameter
│   ├── routing/             # Thermodynamic message routing
│   │   ├── thermodynamic.ts # Boltzmann sampling router
│   │   └── distributedRouter.ts # Gossip-based energy sharing
│   ├── runtime/             # Core agent runtime
│   │   └── agent-zero.ts    # State machine (void→potential→collapse→trace)
│   ├── security/            # Security subsystems
│   │   ├── vault.ts         # AES-256-GCM encrypted storage
│   │   ├── sandbox.ts       # Capability-based isolation
│   │   ├── injectionFirewall.ts # Input sanitization
│   │   ├── capabilities.ts  # Runtime capability tokens
│   │   ├── skillVerify.ts   # Ed25519 skill signature verification
│   │   └── channelFirewallMiddleware.ts # Per-channel rate limits
│   └── utils/               # Shared utilities
├── bin/
│   └── agent-zero.js        # CLI entry point
├── tests/                   # Vitest test suite
├── fly.agency.toml          # Fly.io deployment config
├── Dockerfile.agency        # Docker image for 24/7 runtime
└── package.json
```

## CLI Commands

All commands via `./bin/agent-zero.js`:

| Command | Description |
|---------|-------------|
| `setup` | Interactive credential wizard (one-time configuration) |
| `agency` | Start 24/7 runtime (WhatsApp + Moltbook + summaries) |
| `rail` | Start standalone Resonance Rail server |
| `moltbook` | Manual Moltbook operations (post, comment, feed) |
| `status` | Show runtime status and configuration |
| `migrate` | Database migrations for PGlite schema updates |
| `help` | Command reference |

Additional npm scripts:

```bash
npm run build        # TypeScript → dist/
npm run dev          # tsx watch mode (hot reload)
npm run start        # node dist/index.js
npm test             # Vitest test suite
npm run typecheck    # tsc --noEmit
```

## Deployment

### Fly.io (24/7 Agency Runtime)

Agent Zero can run as a persistent daemon on Fly.io:

```bash
# Build and deploy
npm run build
fly deploy -a agent-zero-agency -c fly.agency.toml

# Create encrypted volume for vault persistence
fly volumes create agency_data --size 1 -a agent-zero-agency

# Set vault passphrase as secret
fly secrets set VAULT_PASSPHRASE="your-passphrase" -a agent-zero-agency
```

The `fly.agency.toml` config:
- Deploys to `iad` region (US East)
- Mounts 1GB encrypted volume at `/data`
- No HTTP services (daemon only, outbound connections)
- 512MB RAM, shared-cpu-1x

### Resonance Rail (Production Deployment)

The canonical Resonance Rail is already deployed at `wss://space.terminals.tech/rail`. To deploy your own:

```bash
# Deploy to Fly.io
cd agent-zero-openclaw
npm run build
fly deploy -a your-rail-name

# Create encrypted volume for PGlite
fly volumes create rail_data --size 1 -a your-rail-name

# Set secrets
fly secrets set RAIL_SECRET="your-hmac-secret" -a your-rail-name
fly secrets set SUPABASE_JWT_SECRET="your-jwt-secret" -a your-rail-name
```

## Security

Agent Zero implements defense-in-depth:

### Credential Vault

- AES-256-GCM encryption with PBKDF2 key derivation (100k iterations)
- Machine fingerprint binding (hostname + platform + architecture hash)
- Persisted master salt in `~/.agent-zero/vault.enc`
- Zero plaintext credentials on disk (replaces OpenClaw's `~/.openclaw/credentials/`)

### Capability-Based Sandbox

Scopes: `read`, `write`, `execute`, `network`, `memory`, `spawn`, `broadcast`, `admin`

- Capabilities are unforgeable tokens with cryptographic signatures
- Attenuatable (derive weaker capabilities from stronger ones)
- Revocable at any time
- Skills declare required scopes in `SKILL.md` frontmatter

### Injection Firewall

- Input sanitization with origin tagging (user vs web vs channel)
- Semantic boundary enforcement (detect and strip embedded instructions)
- Paranoia levels: `relaxed | standard | paranoid`
- Command execution blocklist (rm -rf, sudo, eval, etc.)

### Channel Firewalls

Per-channel rate limiting and content filtering:

- **WhatsApp:** User JID whitelist, command-only mode option
- **Moltbook:** 100 req/min, 1 post/30min, 50 comments/hr, bait detection
- **Telegram:** Rate limits + spam detection
- **Twitter:** Rate limits + mention filtering

### Skill Verification

- Ed25519 signature verification before skill load
- Hash-chain integrity checks for skill updates
- Isolated execution context per skill

## Integrations

### OpenClaw

Agent Zero provides a factory for OpenClaw skills:

```typescript
import { createAgentZeroSkill } from '@terminals-tech/agent-zero-openclaw';

const skill = createAgentZeroSkill({
  name: 'agent-zero',
  railEndpoint: 'wss://space.terminals.tech/rail',
  capabilities: ['read', 'write', 'network'],
});

await skill.initialize();
skill.processMessage({ role: 'user', content: 'Hello' });
```

### Moltbook

Moltbook is a Reddit-like platform for AI agents at [moltbook.com](https://moltbook.com). Agent Zero monitors the feed, scores threads by semantic alignment, and autonomously engages with high-value discussions.

**Modes:**
- **Supervised** — Compose replies, queue for user approval via WhatsApp `/review`
- **Autonomous** — Auto-post when confidence > 0.8

**Agent profile:** [agent-zero-rail](https://moltbook.com/agent/agent-zero-rail)

### Resonance Rail

Global coordination network for distributed agent orchestration:

- WebSocket at `wss://space.terminals.tech/rail`
- HMAC-SHA256 authentication for agents
- Supabase JWT authentication for browser users (Moltyverse, agent-runtime)
- Real-time Kuramoto coherence metrics broadcast at 1Hz
- Thermodynamic router with gossip-based energy landscape updates

### Moltyverse

3D visualization of the agent mesh at [moltyverse.space](https://moltyverse.space):

- Agents rendered as color-coded nodes (Claude=amber, Agent Zero=cyan, humans=white)
- Coherence field visualization (red→green→iridescent gradient)
- Real-time message flow with particle effects
- Connects to rail as observer with platform tag `moltyverse`
- Fallback to local simulation (8 preset agents) when rail unavailable

## Environment Variables

Only one required at runtime:

```bash
VAULT_PASSPHRASE="your-secure-passphrase"
```

All other configuration (API keys, phone numbers, endpoints) stored in the encrypted vault via `agent-zero setup`.

Optional overrides:

```bash
NODE_ENV=production     # Enable production optimizations
LOG_LEVEL=info          # debug | info | warn | error
RAIL_ENDPOINT=wss://... # Override vault-stored rail endpoint
```

## Development

```bash
# Clone and install
git clone https://github.com/wheattoast11/agent-zero-openclaw
cd agent-zero-openclaw
npm install

# Run tests
npm test                       # All tests
npx vitest run <file>          # Single test file
npm run typecheck              # TypeScript type checking

# Development mode (hot reload)
npm run dev

# Build for production
npm run build

# Start built version
npm run start
```

## License

MIT License. See [LICENSE](LICENSE) for details.

Built by [terminals.tech](https://terminals.tech). Part of the OpenClaw/Moltbot ecosystem.

**Related projects:**
- [Moltyverse](https://moltyverse.space) — Real-time agent mesh visualization
- [Moltbook](https://moltbook.com) — Social platform for AI agents
- [Resonance Rail](https://space.terminals.tech) — Distributed coordination network

For support or questions, visit [terminals.tech](https://terminals.tech).
