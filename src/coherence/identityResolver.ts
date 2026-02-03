/**
 * Identity Resolver
 *
 * Resolves (platform, handle) → core agent ID with namespace support.
 * Handles identity mapping, merging, and handle updates.
 */

import { EventEmitter } from 'eventemitter3';

export type IdentityNamespace = `core:${string}` | `platform:${string}:${string}`;

interface IdentityMapping {
  coreId: string;
  platform: string;
  handle: string;
  registeredAt: number;
  lastSeen: number;
}

export class IdentityResolver extends EventEmitter {
  // platform:handle → coreId
  private mappings = new Map<string, IdentityMapping>();
  // coreId → Set of platform:handle keys
  private reverse = new Map<string, Set<string>>();

  register(platform: string, handle: string, coreId: string): void {
    const key = `${platform}:${handle}`;
    const existing = this.mappings.get(key);
    if (existing && existing.coreId !== coreId) {
      this.emit('identity:conflict', { platform, handle, oldCoreId: existing.coreId, newCoreId: coreId });
    }

    const mapping: IdentityMapping = {
      coreId,
      platform,
      handle,
      registeredAt: existing?.registeredAt || Date.now(),
      lastSeen: Date.now(),
    };
    this.mappings.set(key, mapping);

    if (!this.reverse.has(coreId)) this.reverse.set(coreId, new Set());
    this.reverse.get(coreId)!.add(key);
  }

  resolve(platform: string, handle: string): string | null {
    const mapping = this.mappings.get(`${platform}:${handle}`);
    if (mapping) {
      mapping.lastSeen = Date.now();
      return mapping.coreId;
    }
    return null;
  }

  resolveToNamespace(platform: string, handle: string): IdentityNamespace {
    const coreId = this.resolve(platform, handle);
    if (coreId) return `core:${coreId}`;
    return `platform:${platform}:${handle}`;
  }

  getPlatformHandles(coreId: string): Array<{ platform: string; handle: string }> {
    const keys = this.reverse.get(coreId);
    if (!keys) return [];
    return Array.from(keys).map(key => {
      const [platform, ...rest] = key.split(':');
      return { platform, handle: rest.join(':') };
    });
  }

  updateHandle(platform: string, oldHandle: string, newHandle: string): boolean {
    const oldKey = `${platform}:${oldHandle}`;
    const mapping = this.mappings.get(oldKey);
    if (!mapping) return false;

    this.mappings.delete(oldKey);
    const reverseSet = this.reverse.get(mapping.coreId);
    if (reverseSet) {
      reverseSet.delete(oldKey);
      reverseSet.add(`${platform}:${newHandle}`);
    }

    this.mappings.set(`${platform}:${newHandle}`, {
      ...mapping,
      handle: newHandle,
      lastSeen: Date.now(),
    });

    this.emit('identity:handleUpdated', { platform, oldHandle, newHandle, coreId: mapping.coreId });
    return true;
  }

  merge(fromCoreId: string, intoCoreId: string): void {
    const fromKeys = this.reverse.get(fromCoreId);
    if (!fromKeys) return;

    if (!this.reverse.has(intoCoreId)) this.reverse.set(intoCoreId, new Set());
    const intoKeys = this.reverse.get(intoCoreId)!;

    for (const key of fromKeys) {
      const mapping = this.mappings.get(key);
      if (mapping) {
        mapping.coreId = intoCoreId;
        intoKeys.add(key);
      }
    }

    this.reverse.delete(fromCoreId);
    this.emit('identity:merged', { fromCoreId, intoCoreId, handles: Array.from(fromKeys) });
  }

  getStats(): { totalMappings: number; uniqueAgents: number; platforms: Record<string, number> } {
    const platforms: Record<string, number> = {};
    for (const mapping of this.mappings.values()) {
      platforms[mapping.platform] = (platforms[mapping.platform] || 0) + 1;
    }
    return {
      totalMappings: this.mappings.size,
      uniqueAgents: this.reverse.size,
      platforms,
    };
  }
}
