import { randomBytes, pbkdf2, createCipheriv, createDecipheriv } from 'crypto';
import { readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, rm } from 'fs/promises';
import { hostname, userInfo, homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { createHash } from 'crypto';

const VaultEntrySchema = z.object({
  salt: z.string(),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

const VaultFileSchema = z.object({
  masterSalt: z.string().optional(),
  entries: z.record(z.string(), VaultEntrySchema),
});

type VaultEntry = z.infer<typeof VaultEntrySchema>;
type VaultData = Record<string, VaultEntry>;

const VAULT_DIR = process.env['VAULT_DIR'] ?? join(homedir(), '.agent-zero');
const VAULT_PATH = join(VAULT_DIR, 'vault.enc');
const LOCK_PATH = join(VAULT_DIR, 'vault.lock');
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV size
const SALT_LENGTH = 32;

export class Vault {
  private masterKey: Buffer;
  private masterSalt: string;
  private data: VaultData = {};
  private locked = false;

  private constructor(masterKey: Buffer, masterSalt: string) {
    this.masterKey = masterKey;
    this.masterSalt = masterSalt;
  }

  private static async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    const fingerprint = Vault.getMachineFingerprint();
    const combinedSecret = `${fingerprint}:${passphrase}`;
    return new Promise<Buffer>((resolve, reject) => {
      pbkdf2(combinedSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512', (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }

  static async create(passphrase: string): Promise<Vault> {
    await Vault.ensureVaultDirStatic();

    // Try to load existing master salt from vault file
    let masterSaltHex: string | undefined;
    try {
      const raw = await readFile(VAULT_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      // Support both old format (flat record) and new format (with masterSalt)
      if (parsed.masterSalt) {
        masterSaltHex = parsed.masterSalt;
      }
    } catch {
      // No existing vault, will create new
    }

    const salt = masterSaltHex
      ? Buffer.from(masterSaltHex, 'hex')
      : randomBytes(SALT_LENGTH);
    const saltHex = salt.toString('hex');

    const masterKey = await Vault.deriveKey(passphrase, salt);
    const vault = new Vault(masterKey, saltHex);
    await vault.load();

    return vault;
  }

  private static async ensureVaultDirStatic(): Promise<void> {
    try {
      await mkdir(VAULT_DIR, { recursive: true });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  private static getMachineFingerprint(): string {
    const override = process.env['VAULT_MACHINE_FINGERPRINT'];
    if (override) return override;
    const host = hostname();
    const user = userInfo().username;
    const home = homedir();
    const composite = `${host}:${user}:${home}`;
    return createHash('sha256').update(composite).digest('hex');
  }

  private async acquireLock(): Promise<void> {
    const maxRetries = 50;
    const retryDelay = 100;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await mkdir(LOCK_PATH);
        this.locked = true;
        return;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Check for stale lock (older than 30 seconds)
          const lockStat = await stat(LOCK_PATH).catch(() => null);
          if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
            // Stale lock detected, remove and retry
            await rm(LOCK_PATH, { recursive: true }).catch(() => {});
            // Retry immediately
            try {
              await mkdir(LOCK_PATH);
              this.locked = true;
              return;
            } catch {
              // If still fails, continue normal retry loop
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
      await rmdir(LOCK_PATH);
      this.locked = false;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(VAULT_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      const file = VaultFileSchema.safeParse(parsed);
      if (file.success) {
        // New format
        this.data = file.data.entries;
      } else {
        // Legacy flat format — migrate on next persist
        const legacy = z.record(z.string(), VaultEntrySchema).safeParse(parsed);
        if (legacy.success) {
          this.data = legacy.data;
        } else {
          console.warn('Vault corrupted or invalid, initializing empty vault');
          this.data = {};
        }
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.data = {};
      } else if (err instanceof SyntaxError) {
        console.warn('Vault corrupted or invalid, initializing empty vault');
        this.data = {};
      } else {
        throw err;
      }
    }
  }

  private async persist(): Promise<void> {
    await this.acquireLock();
    try {
      const file = { masterSalt: this.masterSalt, entries: this.data };
      const serialized = JSON.stringify(file, null, 2);
      await writeFile(VAULT_PATH, serialized, { mode: 0o600 });
    } finally {
      await this.releaseLock();
    }
  }

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
      this.masterKey.fill(0);

      try {
        await unlink(VAULT_PATH);
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
    } finally {
      await this.releaseLock();
    }
  }
}

export async function createVault(passphrase: string): Promise<Vault> {
  return Vault.create(passphrase);
}
