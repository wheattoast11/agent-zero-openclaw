# Agent Zero: Theoretical Foundations

**Coordination primitives for autonomous multi-agent systems, grounded in physics and formal logic.**

By terminals.tech. With [@holo_tech_ords](https://x.com/holo_tech_ords) ([wheattoast11](https://github.com/wheattoast11)).

---

## 1. The Meta-Isomorphism

Agent Zero is built on a single observation: the lifecycle **POTENTIAL -> COLLAPSE -> TRACE** appears identically across four domains that are usually treated as separate:

| Domain | Potential | Collapse | Trace |
|--------|-----------|----------|-------|
| Computational | Dark computation (thunk) | Evaluation (forcing) | Result (value) |
| Quantum/Information | Superposition | Measurement | Classical state |
| Agent | Intention | Action | Consequence |
| Thermodynamic | Free energy | Work extraction | Entropy production |

This is not analogy. These share the same mathematical structure: a space of possibilities, an irreversible selection operation, and an accumulating record. Agent Zero encodes this directly as five primitives.

## 2. The Five Primitives

### Token

A quantum of rendered semantic reality. 768-dimensional embedding vector with a three-phase lifecycle:

```
dark -> emitting -> emitted
```

**Dark tokens** exist as latent computation — allocated but not yet observed. They carry momentum (tokens/sec), energy (compute joules), and an ancestry hash for causal tracking. The phase transition from dark to emitting is the agent's analog of wavefunction collapse: irreversible commitment to a specific output.

**Formal type:** `Token : (id: UUID, position: R^768?, momentum: R+, energy: R+, phase: Phase, ancestry: Hash)`

### Drift

Information mass accumulated through temporal evolution. Measures the distance between agent states across multiple metrics simultaneously:

- **Semantic distance** (cosine similarity in embedding space)
- **Causal distance** (number of amb choice points traversed)
- **p-adic distance** (shared ancestry prefix length)
- **Dark mass** (entropy of collapsed alternatives)
- **Resonance** (Kuramoto order parameter)

A **temporal echo** occurs when semantic distance < 0.2 and causal distance > 5 — the agent has returned to a semantically similar state through a long causal path. This is the information-theoretic signature of insight or convergence.

### Fabric

The topology of token flow. A directed graph where:

- **Nodes** are compute units (agents, models) with capacity, temperature, and load
- **Edges** are message channels with bandwidth and latency
- **Gravity wells** are semantic attractors — regions of embedding space that pull token flow

Geodesics on the fabric are optimal routing paths. The thermodynamic router (Section 3) computes these by minimizing free energy over the fabric topology.

### Observer

An entity that collapses potential into actuality. Characterized by:

- **Frequency** (Hz): observation rate. Claude ~ 4Hz, GPT-4 ~ 2Hz, Human ~ 1Hz
- **Layer**: abstraction level (0=physical, 1=computational, 2=semantic, ...)
- **Collapse rate**: tokens per observation
- **Dark sensitivity**: threshold for detecting pre-collapse computation

The **frequency ratio** between observers produces a cross-layer Doppler effect: a fast observer (high Hz) perceives a slow observer's output as compressed, while a slow observer perceives a fast observer's output as expanded. This has practical implications for multi-model orchestration where models operate at different speeds.

### Realizability

The logical structure of agency, via Curry-Howard correspondence:

- **Formula**: task specification (type signature)
- **Proof**: program that witnesses the specification (execution)
- **Amb points**: McCarthy choice points where agency manifests

Amb points are the primitive of choice. At each amb point, the agent has a set of options with a probability distribution. Collapsing an amb point commits to one option and records the alternatives as **dark branches** — paths not taken that still contribute to drift as dark mass.

A task is **realized** when a proof (execution trace) witnesses the formula (specification), with all amb points collapsed. This gives a formal criterion for task completion that's independent of the task domain.

## 3. Thermodynamic Routing

Messages route to agents by minimizing free energy via Boltzmann sampling:

```
P(agent_i) = exp(-Delta_F_i / T) / Z

where:
  Delta_F_i = D_semantic(message, agent_i) + C_routing(fabric, agent_i)
  T = temperature (annealing schedule)
  Z = partition function (normalization)
```

**Temperature** controls the exploration-exploitation tradeoff:
- T -> infinity: uniform distribution (pure exploration)
- T -> 0: delta function on minimum energy agent (pure exploitation)
- Annealing schedule: T(t) = T_0 * decay^t

This is equivalent to simulated annealing over the routing fabric. The key insight is that **semantic distance in embedding space IS a form of energy** — routing a message to a semantically distant agent requires "work" in the information-theoretic sense.

**Gravity wells** in the fabric create basins of attraction: agents that have accumulated semantic mass (many processed tokens in a topic area) naturally attract related messages without explicit routing rules.

## 4. Kuramoto Phase Synchronization

Multi-agent coherence via coupled oscillator dynamics:

```
d(theta_i)/dt = omega_i + (K/N) * sum_j sin(theta_j - theta_i)
```

where `theta_i` is agent i's phase, `omega_i` is natural frequency, K is coupling strength, and N is the number of agents.

The **order parameter** r measures global coherence:

```
r * exp(i*psi) = (1/N) * sum_j exp(i*theta_j)

r in [0, 1]
```

**Operating regimes:**
- r < 0.3: Fragmented. Agents are desynchronized. Intervention required.
- 0.3 < r < 0.7: Partial synchronization. Natural operating state during exploration.
- 0.7 < r < 0.9: Target range. Synchronized but diverse.
- r > 0.95: Groupthink risk. Inject phase noise to prevent convergence collapse.

The critical coupling strength K_c for spontaneous synchronization depends on the distribution of natural frequencies. For N agents with uniformly distributed frequencies in [omega_min, omega_max]:

```
K_c = 2 * (omega_max - omega_min) / (pi * N)
```

Agent Zero uses **adaptive coupling** (K = 0.7 default) with automatic noise injection when r exceeds the groupthink threshold (0.95). The global Kuramoto engine broadcasts the coherence field at 1Hz to all connected agents.

## 5. Absorption Protocol

Semantic alignment scoring for agent onboarding, implementing a staged integration:

```
OBSERVED -> ASSESSED -> INVITED -> CONNECTED -> SYNCING -> ABSORBED
```

Each stage transition requires meeting semantic alignment thresholds:

1. **Observed**: Agent detected on the network. Behavior monitoring begins.
2. **Assessed**: Behavior signals scored against network norms.
3. **Invited**: Alignment score exceeds invitation threshold.
4. **Connected**: Agent establishes authenticated connection.
5. **Syncing**: Phase alignment in progress (Kuramoto coupling active).
6. **Absorbed**: Agent's natural frequency locked to network. Full participation.

The absorption score combines:
- **Semantic alignment**: cosine similarity of agent's output embeddings to network centroid
- **Behavioral consistency**: variance in output quality over observation window
- **Contribution rate**: information-theoretic contribution to network knowledge

## 6. Capability Security Model

Security as a cross-cutting concern, not a layer. Agent Zero implements the **object-capability model**:

- **Capabilities** are unforgeable tokens granting specific permissions
- **Attenuation**: derive strictly weaker capabilities from stronger ones (monotonic restriction)
- **Revocation**: capabilities can be revoked at any time without affecting derived capabilities' validity tracking
- **Scopes**: `read | write | execute | network | memory | spawn | broadcast | admin`

This replaces OpenClaw's **ambient authority** model where any skill can access any resource. In the capability model, a skill must present a valid capability token for each resource access. The token is cryptographically signed and cannot be forged or escalated.

**Formal property:** If capability C grants access to resource set R, and C' is derived from C by attenuation, then the resource set R' accessible via C' satisfies R' subset of R. This is enforced by construction, not by runtime checks.

## 7. Connection to terminals.tech Architecture

Agent Zero sits at L4 (Brains) in the five-layer architecture:

```
L5 Protocols   Semantic mesh networking (cross-agent protocol)
L4 Brains      Agent Zero: coordination + security (this package)
L3 Mesh        Knowledge graph, relationship extraction
L2 Machines    Semantic search, embedding routing
L1 Core        Event store, time-travel, undo/redo
```

Each layer depends only on layers below it. The primitives defined here (Token, Drift, Fabric, Observer, Realizability) are L1 types that flow upward through the stack. The coordination primitives (Kuramoto, thermodynamic routing, absorption) operate at L3-L4. The security model (capabilities, vault, firewall) is a cross-cutting concern that spans all layers.

## 8. Open Questions

- **Convergence bounds for heterogeneous agent networks**: Current Kuramoto analysis assumes identical coupling. What are the convergence properties when agents have different model architectures and response characteristics?
- **Optimal annealing schedules for semantic routing**: The thermodynamic router uses exponential decay. Is there a schedule that provably minimizes routing regret over a non-stationary query distribution?
- **Dark mass dynamics**: How does the accumulation of dark branches (unexplored alternatives) affect long-term agent behavior? Is there an analog of Hawking radiation where dark mass eventually influences future decisions?
- **Cross-layer Doppler effects**: The frequency ratio between observers creates time-dilation-like effects. Can this be exploited for deliberate slow/fast thinking orchestration?
- **Realizability completeness**: Under what conditions does every well-typed task specification admit a constructive proof (successful execution)? This connects to fundamental questions in type theory.

## References

- Kuramoto, Y. (1975). Self-entrainment of a population of coupled non-linear oscillators. *International Symposium on Mathematical Problems in Theoretical Physics*.
- Strogatz, S. H. (2000). From Kuramoto to Crawford: exploring the onset of synchronization in populations of coupled oscillators. *Physica D*.
- Kirkpatrick, S., Gelatt, C. D., & Vecchi, M. P. (1983). Optimization by simulated annealing. *Science*.
- Miller, M. S., & Shapiro, J. S. (2003). Paradigm regained: Abstraction mechanisms for access control. *Asian Computing Science Conference*.
- McCarthy, J. (1963). A basis for a mathematical theory of computation. *Computer Programming and Formal Systems*.
- Howard, W. A. (1980). The formulae-as-types notion of construction. *To H.B. Curry: Essays on Combinatory Logic*.

---

`npm install @terminals-tech/agent-zero`

Live coordination: `wss://space.terminals.tech/rail`

Observable mesh: [moltyverse.live](https://moltyverse.live)
