import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../../src/security/vault.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Vault', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
    process.env['VAULT_DIR'] = tmpDir;
  });

  afterEach(() => {
    delete process.env['VAULT_DIR'];
    delete process.env['VAULT_MACHINE_FINGERPRINT'];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('roundtrips store/retrieve', async () => {
    const v = await Vault.create('test-pass');
    await v.store('key1', 'secret-value');
    expect(await v.retrieve('key1')).toBe('secret-value');
  });

  it('creates v2 vault with device slots', async () => {
    const v = await Vault.create('test-pass');
    expect(v.getVersion()).toBe(2);
    expect(v.listDevices()).toHaveLength(1);
    expect(v.listDevices()[0].label).toBe('initial');
  });

  it('rejects wrong passphrase on v2 vault', async () => {
    const v1 = await Vault.create('pass-a');
    await v1.store('key1', 'value');

    await expect(Vault.create('pass-b')).rejects.toThrow('no device slot matches');

    // Original data still intact with correct passphrase
    const v3 = await Vault.create('pass-a');
    expect(await v3.retrieve('key1')).toBe('value');
  });

  it('uses VAULT_MACHINE_FINGERPRINT override', async () => {
    process.env['VAULT_MACHINE_FINGERPRINT'] = 'custom-fingerprint-hash';
    const v = await Vault.create('test-pass');
    await v.store('key1', 'value');
    expect(await v.retrieve('key1')).toBe('value');
  });

  it('lists stored keys', async () => {
    const v = await Vault.create('test-pass');
    await v.store('a', '1');
    await v.store('b', '2');
    const keys = await v.list();
    expect(keys).toContain('a');
    expect(keys).toContain('b');
  });

  it('deletes entries', async () => {
    const v = await Vault.create('test-pass');
    await v.store('key1', 'value');
    await v.delete('key1');
    expect(await v.retrieve('key1')).toBeNull();
  });

  it('addDevice registers native fingerprint', async () => {
    const v = await Vault.create('test-pass');
    await v.store('key1', 'secret');

    const fp = await v.addDevice('second-device');
    expect(fp).toHaveLength(16); // truncated

    expect(v.listDevices()).toHaveLength(2);
    expect(v.listDevices()[1].label).toBe('second-device');

    // Reopen — still works (native fingerprint matches)
    const v2 = await Vault.create('test-pass');
    expect(await v2.retrieve('key1')).toBe('secret');
  });

  it('addDevice allows opening from different fingerprint', async () => {
    // Create vault with fingerprint A
    process.env['VAULT_MACHINE_FINGERPRINT'] = 'fingerprint-a';
    const v1 = await Vault.create('test-pass');
    await v1.store('key1', 'secret');

    // Add device with fingerprint B (simulated via native)
    // Since native is the real machine fingerprint, we add it
    await v1.addDevice('device-b');

    // Now open WITHOUT override — uses native fingerprint (device B slot)
    delete process.env['VAULT_MACHINE_FINGERPRINT'];
    const v2 = await Vault.create('test-pass');
    expect(await v2.retrieve('key1')).toBe('secret');
  });

  it('v1 to v2 auto-migration', async () => {
    // Create a v1-style vault file manually
    const { writeFileSync } = await import('fs');
    const { createCipheriv, randomBytes: rb, pbkdf2: pb2, createHash: ch } = await import('crypto');

    // Derive key the v1 way
    const fingerprint = Vault.getNativeFingerprint();
    const masterSalt = rb(32);
    const combinedSecret = `${fingerprint}:test-pass`;
    const oldKey = await new Promise<Buffer>((resolve, reject) => {
      pb2(combinedSecret, masterSalt, 100_000, 32, 'sha512', (err, key) => {
        if (err) reject(err); else resolve(key);
      });
    });

    // Encrypt an entry with v1 key
    const iv = rb(12);
    const salt = rb(32);
    const cipher = createCipheriv('aes-256-gcm', oldKey, iv);
    const ct = Buffer.concat([cipher.update('my-secret', 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const v1File = {
      masterSalt: masterSalt.toString('hex'),
      entries: {
        'test-key': {
          salt: salt.toString('hex'),
          iv: iv.toString('hex'),
          authTag: authTag.toString('hex'),
          ciphertext: ct.toString('hex'),
        },
      },
    };

    writeFileSync(join(tmpDir, 'vault.enc'), JSON.stringify(v1File));

    // Open — should auto-migrate to v2
    const v = await Vault.create('test-pass');
    expect(v.getVersion()).toBe(2);
    expect(v.listDevices()).toHaveLength(1);
    expect(v.listDevices()[0].label).toBe('migrated-from-v1');
    expect(await v.retrieve('test-key')).toBe('my-secret');
  });
});
