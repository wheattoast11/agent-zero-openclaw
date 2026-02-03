/**
 * Agent Runtime Launcher — Browser-side
 *
 * Boots an AgentZero runtime inside a WebContainer,
 * connects it to the Resonance Rail, and wires xterm for I/O.
 *
 * Prerequisites (in terminals-landing-new):
 *   - @webcontainer/api installed
 *   - @xterm/xterm installed
 *   - Supabase auth session available
 *
 * Usage:
 *   const launcher = new AgentRuntimeLauncher();
 *   await launcher.boot(supabaseJwt, xtermInstance);
 *   // Terminal shows Agent Zero output, agent is on the rail
 *   await launcher.shutdown();
 */

import { RailAuthBridge } from '../rail-auth-bridge.js';
import { loadConfig, type BrowserRuntimeConfig } from './config.js';

// WebContainer types (from @webcontainer/api)
interface WebContainer {
  mount(files: Record<string, unknown>): Promise<void>;
  spawn(cmd: string, args: string[]): Promise<WebContainerProcess>;
  teardown(): void;
}

interface WebContainerProcess {
  output: ReadableStream<string>;
  input: WritableStream<string>;
  exit: Promise<number>;
}

// xterm types (from @xterm/xterm)
interface Terminal {
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
}

export type RuntimeState = 'idle' | 'booting' | 'running' | 'error' | 'stopped';

export interface RuntimeStatus {
  state: RuntimeState;
  agentId: string | null;
  coherence: number;
  phase: number;
  temperature: number;
  connectedAgents: number;
  error?: string;
}

export class AgentRuntimeLauncher {
  private container: WebContainer | null = null;
  private process: WebContainerProcess | null = null;
  private bridge: RailAuthBridge | null = null;
  private config: BrowserRuntimeConfig;
  private _state: RuntimeState = 'idle';
  private _status: RuntimeStatus = {
    state: 'idle',
    agentId: null,
    coherence: 0,
    phase: 0,
    temperature: 0.7,
    connectedAgents: 0,
  };
  private statusListeners: Set<(s: RuntimeStatus) => void> = new Set();

  constructor(config?: Partial<BrowserRuntimeConfig>) {
    this.config = { ...loadConfig(), ...config };
  }

  get state(): RuntimeState { return this._state; }
  get status(): RuntimeStatus { return { ...this._status }; }

  /**
   * Boot the agent runtime.
   * @param jwt - Supabase JWT for rail authentication
   * @param terminal - xterm Terminal instance for I/O
   * @param containerFactory - Function that returns a booted WebContainer (caller provides this)
   */
  async boot(
    jwt: string,
    terminal: Terminal,
    containerFactory: () => Promise<WebContainer>,
  ): Promise<void> {
    if (this._state === 'running') return;
    this.setState('booting');

    try {
      // 1. Connect to rail first (fast, validates JWT)
      this.bridge = new RailAuthBridge(this.config.railEndpoint);

      if (this.config.autoConnect) {
        const { agentId } = await this.bridge.connect(jwt);
        this._status.agentId = agentId;
        terminal.write('\x1b[36m[Rail]\x1b[0m Connected as ' + agentId + '\r\n');
      }

      // Wire coherence updates
      this.bridge.onCoherence((c) => {
        this._status.coherence = c.globalR;
        this._status.phase = c.meanPhase;
        this._status.connectedAgents = c.oscillators.length;
        this.notifyStatus();
      });

      this.bridge.onClose(() => {
        terminal.write('\x1b[33m[Rail]\x1b[0m Disconnected\r\n');
      });

      // 2. Boot WebContainer
      terminal.write('\x1b[90mBooting WebContainer...\x1b[0m\r\n');
      this.container = await containerFactory();

      // 3. Mount agent-zero files
      await this.container.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'agent-zero-browser',
              type: 'module',
              dependencies: {
                '@terminals-tech/agent-zero-openclaw': '0.2.0',
              },
            }),
          },
        },
        'index.js': {
          file: {
            contents: [
              `import { createAgentZeroSkill } from '@terminals-tech/agent-zero-openclaw';`,
              `const skill = createAgentZeroSkill({`,
              `  name: ${JSON.stringify(this.config.name)},`,
              `  frequency: ${this.config.frequency},`,
              `  temperature: ${this.config.temperature},`,
              `  tickRate: ${this.config.tickRateMs},`,
              `  darkSensitivity: ${this.config.darkSensitivity},`,
              `});`,
              `await skill.initialize();`,
              `console.log('[Agent Zero] Runtime started: ' + skill.getState().state);`,
              `// Keep alive`,
              `setInterval(() => {}, 1000);`,
            ].join('\n'),
          },
        },
      });

      // 4. Install + run
      terminal.write('\x1b[90mInstalling dependencies...\x1b[0m\r\n');
      const install = await this.container.spawn('npm', ['install']);
      install.output.pipeTo(new WritableStream({
        write(chunk) { terminal.write(chunk); },
      })).catch(() => {});
      await install.exit;

      terminal.write('\x1b[90mStarting runtime...\x1b[0m\r\n');
      this.process = await this.container.spawn('node', ['index.js']);

      // Pipe output to terminal
      this.process.output.pipeTo(new WritableStream({
        write(chunk) { terminal.write(chunk); },
      })).catch(() => {});

      // Pipe terminal input to process
      const writer = this.process.input.getWriter();
      terminal.onData((data) => {
        writer.write(data).catch(() => {});
      });

      this.setState('running');
      this._status.temperature = this.config.temperature;
      this.notifyStatus();

      // Handle process exit
      this.process.exit.then((code) => {
        terminal.write(`\r\n\x1b[90m[Process exited: ${code}]\x1b[0m\r\n`);
        if (this._state === 'running') this.setState('stopped');
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._status.error = msg;
      this.setState('error');
      terminal.write(`\x1b[31m[Error]\x1b[0m ${msg}\r\n`);
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this.bridge?.disconnect();
    this.bridge = null;
    this.container?.teardown();
    this.container = null;
    this.process = null;
    this.setState('stopped');
    this._status.agentId = null;
    this.notifyStatus();
  }

  onStatus(cb: (s: RuntimeStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  getRailBridge(): RailAuthBridge | null {
    return this.bridge;
  }

  private setState(state: RuntimeState): void {
    this._state = state;
    this._status.state = state;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    const snapshot = { ...this._status };
    for (const cb of this.statusListeners) cb(snapshot);
  }
}
