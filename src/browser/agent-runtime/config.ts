/**
 * Agent Runtime Configuration — Browser-side defaults
 *
 * Default AgentZero config for browser-hosted runtimes.
 * Users can override via UI or localStorage.
 */

export interface BrowserRuntimeConfig {
  /** Agent display name */
  name: string;
  /** Kuramoto natural frequency in Hz */
  frequency: number;
  /** Thermodynamic temperature (0=exploitation, 1=exploration) */
  temperature: number;
  /** Runtime tick rate in ms */
  tickRateMs: number;
  /** Sensitivity to dark tokens (potential detection) */
  darkSensitivity: number;
  /** Rail endpoint */
  railEndpoint: string;
  /** Auto-connect to rail on boot */
  autoConnect: boolean;
}

const STORAGE_KEY = 'agent-zero-runtime-config';

const DEFAULTS: BrowserRuntimeConfig = {
  name: 'Browser Agent',
  frequency: 4,
  temperature: 0.7,
  tickRateMs: 50,
  darkSensitivity: 0.5,
  railEndpoint: 'wss://space.terminals.tech',
  autoConnect: true,
};

export function loadConfig(): BrowserRuntimeConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<BrowserRuntimeConfig>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return { ...DEFAULTS };
}

export function saveConfig(config: Partial<BrowserRuntimeConfig>): BrowserRuntimeConfig {
  const merged = { ...loadConfig(), ...config };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // localStorage unavailable
  }
  return merged;
}

export function resetConfig(): BrowserRuntimeConfig {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // noop
  }
  return { ...DEFAULTS };
}

export { DEFAULTS as DEFAULT_RUNTIME_CONFIG };
