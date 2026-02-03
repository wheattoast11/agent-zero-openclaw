/**
 * RuntimePanel — React component for browser-side Agent Zero runtime.
 *
 * Split view: terminal (xterm) + agent state panel.
 * Shows: agent state, coherence, phase, temperature.
 * Controls: start/stop, temperature slider.
 *
 * To use in terminals-landing-new, copy this file and import it.
 * Dependencies: react, @xterm/xterm, @xterm/addon-fit
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentRuntimeLauncher, type RuntimeStatus, type RuntimeState } from './launcher.js';
import { DEFAULT_RUNTIME_CONFIG, saveConfig, type BrowserRuntimeConfig } from './config.js';

// xterm types
interface Terminal {
  open(el: HTMLElement): void;
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  dispose(): void;
}

interface FitAddon {
  fit(): void;
}

interface RuntimePanelProps {
  jwt: string;
  containerFactory: () => Promise<unknown>;
  onStateChange?: (state: RuntimeState) => void;
  className?: string;
}

const STATE_COLORS: Record<RuntimeState, string> = {
  idle: '#666',
  booting: '#f59e0b',
  running: '#22c55e',
  error: '#ef4444',
  stopped: '#666',
};

export function RuntimePanel({ jwt, containerFactory, onStateChange, className }: RuntimePanelProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const launcherRef = useRef<AgentRuntimeLauncher | null>(null);

  const [status, setStatus] = useState<RuntimeStatus>({
    state: 'idle',
    agentId: null,
    coherence: 0,
    phase: 0,
    temperature: DEFAULT_RUNTIME_CONFIG.temperature,
    connectedAgents: 0,
  });
  const [temperature, setTemperature] = useState(DEFAULT_RUNTIME_CONFIG.temperature);

  // Init terminal
  useEffect(() => {
    if (!termRef.current) return;

    let term: Terminal;
    let fitAddon: FitAddon;

    // Dynamic imports to avoid SSR issues
    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xtermMod, fitMod]) => {
      const XTerminal = xtermMod.Terminal;
      const FitAddonClass = fitMod.FitAddon;

      term = new XTerminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"Berkeley Mono", "JetBrains Mono", monospace',
        theme: {
          background: '#0a0a0a',
          foreground: '#e0e0e0',
          cursor: '#00ffff',
          selectionBackground: '#264f78',
        },
      }) as unknown as Terminal;

      fitAddon = new FitAddonClass() as unknown as FitAddon;
      (term as unknown as { loadAddon(a: unknown): void }).loadAddon(fitAddon);

      term.open(termRef.current!);
      fitAddon.fit();

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      term.write('\x1b[36m╔══════════════════════════════════════╗\x1b[0m\r\n');
      term.write('\x1b[36m║\x1b[0m   Agent Zero Browser Runtime        \x1b[36m║\x1b[0m\r\n');
      term.write('\x1b[36m║\x1b[0m   terminals.tech                    \x1b[36m║\x1b[0m\r\n');
      term.write('\x1b[36m╚══════════════════════════════════════╝\x1b[0m\r\n\r\n');
    });

    const onResize = () => fitAddonRef.current?.fit();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      terminalRef.current?.dispose();
    };
  }, []);

  // Status listener
  useEffect(() => {
    if (!launcherRef.current) return;
    const unsub = launcherRef.current.onStatus((s) => {
      setStatus(s);
      onStateChange?.(s.state);
    });
    return unsub;
  }, [onStateChange]);

  const handleStart = useCallback(async () => {
    if (!terminalRef.current) return;
    const launcher = new AgentRuntimeLauncher({ temperature });
    launcherRef.current = launcher;

    const unsub = launcher.onStatus((s) => {
      setStatus(s);
      onStateChange?.(s.state);
    });

    try {
      await launcher.boot(
        jwt,
        terminalRef.current,
        containerFactory as () => Promise<never>,
      );
    } catch {
      // Error already shown in terminal
    }

    return unsub;
  }, [jwt, containerFactory, temperature, onStateChange]);

  const handleStop = useCallback(async () => {
    await launcherRef.current?.shutdown();
    launcherRef.current = null;
  }, []);

  const handleTemperatureChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setTemperature(val);
    saveConfig({ temperature: val });
  }, []);

  const isRunning = status.state === 'running';
  const isBooting = status.state === 'booting';

  return (
    <div className={className} style={{ display: 'flex', gap: 12, height: '100%' }}>
      {/* Terminal */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div ref={termRef} style={{ height: '100%', borderRadius: 8, overflow: 'hidden' }} />
      </div>

      {/* Status Panel */}
      <div style={{
        width: 260,
        padding: 16,
        background: '#111',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        fontFamily: '"Berkeley Mono", monospace',
        fontSize: 12,
        color: '#ccc',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>Agent State</div>

        {/* State indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: STATE_COLORS[status.state],
            boxShadow: isRunning ? '0 0 8px #22c55e' : undefined,
          }} />
          <span style={{ textTransform: 'uppercase', letterSpacing: 1 }}>{status.state}</span>
        </div>

        {/* Agent ID */}
        {status.agentId && (
          <div>
            <div style={{ color: '#888', fontSize: 10 }}>AGENT ID</div>
            <div style={{ wordBreak: 'break-all' }}>{status.agentId}</div>
          </div>
        )}

        {/* Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ color: '#888', fontSize: 10 }}>COHERENCE</div>
            <div style={{ fontSize: 18, color: '#00ffff' }}>{(status.coherence * 100).toFixed(1)}%</div>
          </div>
          <div>
            <div style={{ color: '#888', fontSize: 10 }}>PHASE</div>
            <div style={{ fontSize: 18, color: '#ff9900' }}>{status.phase.toFixed(2)}</div>
          </div>
          <div>
            <div style={{ color: '#888', fontSize: 10 }}>AGENTS</div>
            <div style={{ fontSize: 18 }}>{status.connectedAgents}</div>
          </div>
          <div>
            <div style={{ color: '#888', fontSize: 10 }}>TEMP</div>
            <div style={{ fontSize: 18, color: '#ff4444' }}>{temperature.toFixed(2)}</div>
          </div>
        </div>

        {/* Temperature slider */}
        <div>
          <div style={{ color: '#888', fontSize: 10, marginBottom: 4 }}>TEMPERATURE</div>
          <input
            type="range"
            min="0" max="1" step="0.05"
            value={temperature}
            onChange={handleTemperatureChange}
            style={{ width: '100%' }}
          />
        </div>

        {/* Controls */}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 8 }}>
          {!isRunning && !isBooting ? (
            <button
              onClick={handleStart}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 6, border: 'none',
                background: '#22c55e', color: '#000', fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Launch
            </button>
          ) : (
            <button
              onClick={handleStop}
              disabled={isBooting}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 6, border: 'none',
                background: '#ef4444', color: '#fff', fontWeight: 600,
                cursor: isBooting ? 'not-allowed' : 'pointer',
                opacity: isBooting ? 0.5 : 1, fontFamily: 'inherit',
              }}
            >
              Stop
            </button>
          )}
        </div>

        {/* Error */}
        {status.error && (
          <div style={{ color: '#ef4444', fontSize: 11, wordBreak: 'break-word' }}>
            {status.error}
          </div>
        )}
      </div>
    </div>
  );
}
