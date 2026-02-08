import { randomBytes, pbkdf2, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, rm } from 'fs/promises';
import { hostname, userInfo, homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

const VaultEntrySchema = z.object({
  salt: z.string(),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

const DeviceSlotSchema = z.object({
  salt: z.string(),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
  addedAt: z.string(),
  label: z.string().optional(),
});

const VaultFileV2Schema = z.object({
  version: z.literal(2),
  deviceSlots: z.array(DeviceSlotSchema).min(1),
  entries: z.record(z.string(), VaultEntrySchema),
});

const VaultFileV1Schema = z.object({
  masterSalt: z.string().optional(),
  entries: z.record(z.string(), VaultEntrySchema),
});

type VaultEntry = z.infer<typeof VaultEntrySchema>;
type DeviceSlot = z.infer<typeof DeviceSlotSchema>;
type VaultData = Record<string, VaultEntry>;

// ============================================================================
// CONSTANTS
// ============================================================================

function getVaultDir(): string {
  return process.env['VAULT_DIR'] ?? join(homedir(), '.agent-zero');
}
function getVaultPath(): string {
  return join(getVaultDir(), 'vault.enc');
}
function getLockPath(): string {
  return join(getVaultDir(), 'vault.lock');
}
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV size
const SALT_LENGTH = 32;

// ============================================================================
// VAULT
// ============================================================================

export class Vault {
  private masterKey: Buffer;
  private passphrase: string;
  private deviceSlots: DeviceSlot[];
  private data: VaultData = {};
  private locked = false;
  private version: 1 | 2 = 2;
  // v1 compat: masterSalt used when persisting in v1 mode (before migration)
  private masterSalt?: string;

  private constructor(masterKey: Buffer, passphrase: string, deviceSlots: DeviceSlot[], masterSalt?: string) {
    this.masterKey = masterKey;
    this.passphrase = passphrase;
    this.deviceSlots = deviceSlots;
    this.masterSalt = masterSalt;
  }

  // ==========================================================================
  // FINGERPRINT
  // ==========================================================================

  /**
   * Native machine fingerprint (ignores VAULT_MACHINE_FINGERPRINT override).
   * Used by addDevice() to register the actual current machine.
   */
  static getNativeFingerprint(): string {
    const host = hostname();
    const user = userInfo().username;
    const home = homedir();
    return createHash('sha256').update(`${host}:${user}:${home}`).digest('hex');
  }

  /**
   * Auth fingerprint — respects VAULT_MACHINE_FINGERPRINT override.
   * Used for vault open/key derivation.
   */
  private static getAuthFingerprint(): string {
    return process.env['VAULT_MACHINE_FINGERPRINT'] ?? Vault.getNativeFingerprint();
  }

  // ==========================================================================
  // KEY DERIVATION
  // ==========================================================================

  private static async deriveDeviceKey(passphrase: string, fingerprint: string, salt: Buffer): Promise<Buffer> {
    const combinedSecret = `${fingerprint}:${passphrase}`;
    return new Promise<Buffer>((resolve, reject) => {
      pbkdf2(combinedSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512', (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }

  /** v1 compat: derive key using auth fingerprint (old behavior). */
  private static async deriveKeyV1(passphrase: string, salt: Buffer): Promise<Buffer> {
    return Vault.deriveDeviceKey(passphrase, Vault.getAuthFingerprint(), salt);
  }

  // ==========================================================================
  // MASTER KEY ENCRYPTION (for device slots)
  // ==========================================================================

  private static encryptMasterKey(deviceKey: Buffer, masterKey: Buffer): { iv: string; authTag: string; ciphertext: string } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, deviceKey, iv);
    const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };
  }

  private static decryptMasterKey(deviceKey: Buffer, slot: DeviceSlot): Buffer {
    const iv = Buffer.from(slot.iv, 'hex');
    const authTag = Buffer.from(slot.authTag, 'hex');
    const ciphertext = Buffer.from(slot.ciphertext, 'hex');
    const decipher = createDecipheriv(ALGORITHM, deviceKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // ==========================================================================
  // FACTORY: create / open
  // ==========================================================================

  static async create(passphrase: string): Promise<Vault> {
    await Vault.ensureVaultDirStatic();

    let raw: unknown;
    try {
      const content = await readFile(getVaultPath(), 'utf-8');
      raw = JSON.parse(content);
    } catch {
      raw = null;
    }

    // No existing vault → create fresh v2
    if (!raw) {
      return Vault.createFreshV2(passphrase);
    }

    // Try v2 format first
    const v2 = VaultFileV2Schema.safeParse(raw);
    if (v2.success) {
      return Vault.openV2(passphrase, v2.data);
    }

    // v1 format (with or without masterSalt wrapper)
    return Vault.openV1(passphrase, raw);
  }

  private static async createFreshV2(passphrase: string): Promise<Vault> {
    const masterKey = randomBytes(KEY_LENGTH);
    const fingerprint = Vault.getAuthFingerprint();
    const slotSalt = randomBytes(SALT_LENGTH);
    const deviceKey = await Vault.deriveDeviceKey(passphrase, fingerprint, slotSalt);
    const encrypted = Vault.encryptMasterKey(deviceKey, masterKey);

    const slot: DeviceSlot = {
      salt: slotSalt.toString('hex'),
      ...encrypted,
      addedAt: new Date().toISOString(),
      label: 'initial',
    };

    const vault = new Vault(masterKey, passphrase, [slot]);
    vault.version = 2;
    vault.data = {};
    await vault.persist();
    return vault;
  }

  private static async openV2(passphrase: string, file: z.infer<typeof VaultFileV2Schema>): Promise<Vault> {
    const fingerprint = Vault.getAuthFingerprint();

    for (const slot of file.deviceSlots) {
      try {
        const slotSalt = Buffer.from(slot.salt, 'hex');
        const deviceKey = await Vault.deriveDeviceKey(passphrase, fingerprint, slotSalt);
        const masterKey = Vault.decryptMasterKey(deviceKey, slot);

        const vault = new Vault(masterKey, passphrase, [...file.deviceSlots]);
        vault.version = 2;
        vault.data = file.entries;
        return vault;
      } catch {
        continue;
      }
    }

    throw new Error(
      'Vault: no device slot matches current fingerprint. '
      + 'Set VAULT_MACHINE_FINGERPRINT=<old-fingerprint> to recover, then run: addDevice()',
    );
  }

  private static async openV1(passphrase: string, raw: unknown): Promise<Vault> {
    // Parse v1 — two sub-formats: { masterSalt, entries } or flat { key: entry }
    let masterSaltHex: string | undefined;
    let entries: VaultData;

    const v1 = VaultFileV1Schema.safeParse(raw);
    if (v1.success) {
      masterSaltHex = v1.data.masterSalt;
      entries = v1.data.entries;
    } else {
      // Legacy flat format
      const flat = z.record(z.string(), VaultEntrySchema).safeParse(raw);
      entries = flat.success ? flat.data : {};
    }

    const salt = masterSaltHex
      ? Buffer.from(masterSaltHex, 'hex')
      : randomBytes(SALT_LENGTH);
    const saltHex = salt.toString('hex');

    const oldKey = await Vault.deriveKeyV1(passphrase, salt);

    // Test if we can decrypt any entry
    let canDecrypt = Object.keys(entries).length === 0; // empty = trivially migratable
    for (const entry of Object.values(entries)) {
      try {
        const iv = Buffer.from(entry.iv, 'hex');
        const authTag = Buffer.from(entry.authTag, 'hex');
        const ct = Buffer.from(entry.ciphertext, 'hex');
        const decipher = createDecipheriv(ALGORITHM, oldKey, iv);
        decipher.setAuthTag(authTag);
        decipher.update(ct);
        decipher.final();
        canDecrypt = true;
        break;
      } catch {
        continue;
      }
    }

    if (canDecrypt) {
      // Auto-migrate to v2
      return Vault.migrateV1ToV2(passphrase, oldKey, entries);
    }

    // Can't decrypt — stay v1, warn. Existing "entries return null" behavior preserved.
    console.warn('Vault: fingerprint mismatch. Entries from previous device will return null.');
    console.warn('To migrate: set VAULT_MACHINE_FINGERPRINT=<old-fingerprint>, reopen, then call addDevice().');
    const vault = new Vault(oldKey, passphrase, [], saltHex);
    vault.version = 1;
    vault.data = entries;
    return vault;
  }

  private static async migrateV1ToV2(passphrase: string, oldKey: Buffer, entries: VaultData): Promise<Vault> {
    const newMasterKey = randomBytes(KEY_LENGTH);
    const fingerprint = Vault.getAuthFingerprint();

    // Re-encrypt all entries with new random master key
    const newEntries: VaultData = {};
    let migrated = 0;
    let dropped = 0;

    for (const [key, entry] of Object.entries(entries)) {
      try {
        // Decrypt with old key
        const iv = Buffer.from(entry.iv, 'hex');
        const authTag = Buffer.from(entry.authTag, 'hex');
        const ct = Buffer.from(entry.ciphertext, 'hex');
        const decipher = createDecipheriv(ALGORITHM, oldKey, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);

        // Re-encrypt with new master key
        const newIv = randomBytes(IV_LENGTH);
        const newSalt = randomBytes(SALT_LENGTH);
        const cipher = createCipheriv(ALGORITHM, newMasterKey, newIv);
        const newCt = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const newAuthTag = cipher.getAuthTag();

        newEntries[key] = {
          salt: newSalt.toString('hex'),
          iv: newIv.toString('hex'),
          authTag: newAuthTag.toString('hex'),
          ciphertext: newCt.toString('hex'),
        };
        migrated++;
      } catch {
        // Entry can't be decrypted (stale from old passphrase) — drop
        dropped++;
      }
    }

    // Create device slot for current auth fingerprint
    const slotSalt = randomBytes(SALT_LENGTH);
    const deviceKey = await Vault.deriveDeviceKey(passphrase, fingerprint, slotSalt);
    const encrypted = Vault.encryptMasterKey(deviceKey, newMasterKey);

    const slot: DeviceSlot = {
      salt: slotSalt.toString('hex'),
      ...encrypted,
      addedAt: new Date().toISOString(),
      label: 'migrated-from-v1',
    };

    if (migrated > 0 || dropped > 0) {
      console.log(`Vault migrated v1→v2: ${migrated} entries migrated, ${dropped} stale entries dropped`);
    }

    const vault = new Vault(newMasterKey, passphrase, [slot]);
    vault.version = 2;
    vault.data = newEntries;
    await vault.persist();
    return vault;
  }

  // ==========================================================================
  // DEVICE MANAGEMENT
  // ==========================================================================

  /**
   * Register the current machine's native fingerprint as a new device slot.
   * Always uses the NATIVE fingerprint (ignores VAULT_MACHINE_FINGERPRINT override),
   * so you can open with an override and add-device to register the real machine.
   */
  async addDevice(label?: string): Promise<string> {
    if (this.version !== 2) {
      throw new Error('Cannot add device to v1 vault. Open with correct fingerprint first to trigger migration.');
    }

    const fingerprint = Vault.getNativeFingerprint();
    const slotSalt = randomBytes(SALT_LENGTH);
    const deviceKey = await Vault.deriveDeviceKey(this.passphrase, fingerprint, slotSalt);
    const encrypted = Vault.encryptMasterKey(deviceKey, this.masterKey);

    const slot: DeviceSlot = {
      salt: slotSalt.toString('hex'),
      ...encrypted,
      addedAt: new Date().toISOString(),
      ...(label ? { label } : {}),
    };

    this.deviceSlots.push(slot);
    await this.persist();
    return fingerprint.slice(0, 16); // truncated for display
  }

  /**
   * List registered device slots (no secrets exposed).
   */
  listDevices(): Array<{ index: number; addedAt: string; label?: string }> {
    return this.deviceSlots.map((slot, i) => ({
      index: i,
      addedAt: slot.addedAt,
      label: slot.label,
    }));
  }

  getVersion(): number {
    return this.version;
  }

  // ==========================================================================
  // LOCKING
  // ==========================================================================

  private static async ensureVaultDirStatic(): Promise<void> {
    try {
      await mkdir(getVaultDir(), { recursive: true });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  private async acquireLock(): Promise<void> {
    const maxRetries = 50;
    const retryDelay = 100;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await mkdir(getLockPath());
        this.locked = true;
        return;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Check for stale lock (older than 30 seconds)
          const lockStat = await stat(getLockPath()).catch(() => null);
          if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
            await rm(getLockPath(), { recursive: true }).catch(() => {});
            try {
              await mkdir(getLockPath());
              this.locked = true;
              return;
            } catch {
              // continue retry loop
            }
          }
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          throw err;
        }
      }
    }
    throw new Error('Failed to acquire vault lock after retries');
  }

  private async releaseLock(): Promise<void> {
    if (!this.locked) return;
    try {
      await rmdir(getLockPath());
      this.locked = false;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ==========================================================================
  // ENCRYPT / DECRYPT (entry-level, using master key)
  // ==========================================================================

  private encrypt(plaintext: string): VaultEntry {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };
  }

  private decrypt(entry: VaultEntry): string {
    const iv = Buffer.from(entry.iv, 'hex');
    const authTag = Buffer.from(entry.authTag, 'hex');
    const ciphertext = Buffer.from(entry.ciphertext, 'hex');

    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString('utf-8');
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  async store(key: string, value: string): Promise<void> {
    const entry = this.encrypt(value);
    this.data[key] = entry;
    await this.persist();
  }

  async retrieve(key: string): Promise<string | null> {
    const entry = this.data[key];
    if (!entry) return null;

    try {
      return this.decrypt(entry);
    } catch {
      // Silently return null for decrypt failures (expected for mixed-passphrase entries)
      return null;
    }
  }

  async rotate(key: string, newValue: string): Promise<void> {
    if (!this.data[key]) {
      throw new Error(`Key "${key}" does not exist`);
    }
    await this.store(key, newValue);
  }

  async delete(key: string): Promise<void> {
    delete this.data[key];
    await this.persist();
  }

  async list(): Promise<string[]> {
    return Object.keys(this.data);
  }

  async migrateFromPlaintext(dir: string): Promise<number> {
    let count = 0;

    try {
      const files = await readdir(dir);

      for (const file of files) {
        if (file.startsWith('.')) continue;

        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          await this.store(file, content.trim());
          count++;
        } catch (err) {
          console.warn(`Failed to migrate ${file}:`, err);
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    return count;
  }

  async destroy(): Promise<void> {
    await this.acquireLock();
    try {
      this.data = {};
      this.deviceSlots = [];
      this.masterKey.fill(0);

      try {
        await unlink(getVaultPath());
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
    } finally {
      await this.releaseLock();
    }
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  private async persist(): Promise<void> {
    await this.acquireLock();
    try {
      let file: unknown;
      if (this.version === 2) {
        file = { version: 2, deviceSlots: this.deviceSlots, entries: this.data };
      } else {
        // v1 fallback (pre-migration)
        file = { masterSalt: this.masterSalt, entries: this.data };
      }
      const serialized = JSON.stringify(file, null, 2);
      await writeFile(getVaultPath(), serialized, { mode: 0o600 });
    } finally {
      await this.releaseLock();
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export async function createVault(passphrase: string): Promise<Vault> {
  return Vault.create(passphrase);
}
