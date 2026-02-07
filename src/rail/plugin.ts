/**
 * Rail Plugin System (A4)
 *
 * Allows external code to register with the rail and receive/send messages.
 * Plugins receive notifications for broadcasts, coherence updates, and trace events.
 */

import type { ResonanceRailServer, RailMessage, RailStats, RailClient } from './server.js';
import type { TraceRecord } from './persistence.js';
import { railLog } from './logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface RailPlugin {
  id: string;
  name: string;

  /** Called when plugin is registered with the rail. */
  onRegister?(context: RailPluginContext): void;

  /** Called on each broadcast message. */
  onBroadcast?(message: RailMessage): void;

  /** Called on each coherence update (from Kuramoto tick). */
  onCoherence?(coherence: number): void;

  /** Called on trace events (reasoning traces from agents). */
  onTrace?(trace: { agentId: string; content: string; kind: string }): void;
}

export interface RailPluginContext {
  /** Send a message through the rail. */
  sendMessage(message: Omit<RailMessage, 'timestamp'>): void;

  /** Get current server stats. */
  getStats(): RailStats;

  /** Get connected agents. */
  getAgents(): RailClient[];

  /** Search traces by embedding similarity. */
  searchTraces(embedding: number[], limit?: number): Promise<TraceRecord[]>;
}

// ============================================================================
// PLUGIN MANAGER
// ============================================================================

export class RailPluginManager {
  private plugins: Map<string, RailPlugin> = new Map();
  private context: RailPluginContext;

  constructor(rail: ResonanceRailServer) {
    this.context = {
      sendMessage(message: Omit<RailMessage, 'timestamp'>): void {
        rail.processMessage({
          ...message,
          timestamp: Date.now(),
        } as RailMessage);
      },

      getStats(): RailStats {
        return rail.getStats();
      },

      getAgents(): RailClient[] {
        return rail.getClients();
      },

      async searchTraces(embedding: number[], limit?: number): Promise<TraceRecord[]> {
        const persistence = rail.getPersistence();
        if (!persistence) return [];
        return persistence.searchTraces({ embedding, limit });
      },
    };
  }

  /**
   * Register a plugin with the rail.
   * Calls plugin.onRegister with the context if defined.
   */
  register(plugin: RailPlugin): void {
    if (this.plugins.has(plugin.id)) {
      railLog.warn('plugin', 'Plugin already registered, replacing', { id: plugin.id });
    }

    this.plugins.set(plugin.id, plugin);

    if (plugin.onRegister) {
      try {
        plugin.onRegister(this.context);
      } catch (err) {
        railLog.error('plugin', 'Plugin onRegister failed', {
          id: plugin.id,
          error: String(err),
        });
      }
    }

    railLog.info('plugin', 'Plugin registered', { id: plugin.id, name: plugin.name });
  }

  /**
   * Unregister a plugin by ID.
   */
  unregister(pluginId: string): void {
    const existed = this.plugins.delete(pluginId);
    if (existed) {
      railLog.info('plugin', 'Plugin unregistered', { id: pluginId });
    }
  }

  /**
   * Get a registered plugin by ID.
   */
  getPlugin(pluginId: string): RailPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * List all registered plugins.
   */
  listPlugins(): Array<{ id: string; name: string }> {
    const list: Array<{ id: string; name: string }> = [];
    for (const plugin of this.plugins.values()) {
      list.push({ id: plugin.id, name: plugin.name });
    }
    return list;
  }

  // ==========================================================================
  // NOTIFICATION METHODS (called by server)
  // ==========================================================================

  /**
   * Notify all plugins of a broadcast message.
   */
  notifyBroadcast(message: RailMessage): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onBroadcast) {
        try {
          plugin.onBroadcast(message);
        } catch (err) {
          railLog.error('plugin', 'Plugin onBroadcast error', {
            id: plugin.id,
            error: String(err),
          });
        }
      }
    }
  }

  /**
   * Notify all plugins of a coherence update.
   */
  notifyCoherence(coherence: number): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onCoherence) {
        try {
          plugin.onCoherence(coherence);
        } catch (err) {
          railLog.error('plugin', 'Plugin onCoherence error', {
            id: plugin.id,
            error: String(err),
          });
        }
      }
    }
  }

  /**
   * Notify all plugins of a trace event.
   */
  notifyTrace(trace: { agentId: string; content: string; kind: string }): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onTrace) {
        try {
          plugin.onTrace(trace);
        } catch (err) {
          railLog.error('plugin', 'Plugin onTrace error', {
            id: plugin.id,
            error: String(err),
          });
        }
      }
    }
  }
}
