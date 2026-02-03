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

  it('returns null for wrong passphrase without corrupting data', async () => {
    const v1 = await Vault.create('pass-a');
    await v1.store('key1', 'value');

    const v2 = await Vault.create('pass-b');
    expect(await v2.retrieve('key1')).toBeNull();

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
});
