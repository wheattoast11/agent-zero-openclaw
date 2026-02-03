import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

const FileHashSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const SkillManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  files: z.array(FileHashSchema),
  timestamp: z.number(),
  publicKey: z.string()
});

export const SignedManifestSchema = SkillManifestSchema.extend({
  signature: z.string()
});

export type FileHash = z.infer<typeof FileHashSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SignedManifest = z.infer<typeof SignedManifestSchema>;

// ============================================================================
// KEYPAIR GENERATION
// ============================================================================

/**
 * Generate Ed25519 keypair for skill signing
 */
export function generateSigningKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  return { publicKey, privateKey };
}

// ============================================================================
// FILE HASHING
// ============================================================================

/**
 * Compute SHA256 hash of file contents
 */
export async function hashFile(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * Walk directory recursively and collect file paths
 */
async function walkDirectory(dir: string, baseDir: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, .git, etc.
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
        continue;
      }
      files.push(...(await walkDirectory(fullPath, baseDir)));
    } else if (entry.isFile()) {
      files.push(relative(baseDir, fullPath));
    }
  }

  return files.sort(); // Deterministic ordering
}

// ============================================================================
// MANIFEST CREATION
// ============================================================================

/**
 * Create skill manifest by hashing all files in directory
 */
export async function createManifest(
  skillDir: string,
  name: string,
  version: string
): Promise<SkillManifest> {
  const filePaths = await walkDirectory(skillDir);
  const files: FileHash[] = [];

  for (const relPath of filePaths) {
    const fullPath = join(skillDir, relPath);
    const sha256 = await hashFile(fullPath);
    files.push({ path: relPath, sha256 });
  }

  // Configure via SKILL_VERIFY_PUBLIC_KEY env var or pass to constructor
  return {
    name,
    version,
    files,
    timestamp: Date.now(),
    publicKey: process.env['SKILL_VERIFY_PUBLIC_KEY'] ?? ''
  };
}

// ============================================================================
// SIGNING & VERIFICATION
// ============================================================================

/**
 * Compute deterministic hash chain from manifest files
 */
function computeManifestHash(manifest: SkillManifest): Buffer {
  // Concatenate all file hashes in order
  const hashChain = manifest.files
    .map(f => f.sha256)
    .join('');

  // Add metadata
  const payload = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    timestamp: manifest.timestamp,
    publicKey: manifest.publicKey,
    hashChain
  });

  return Buffer.from(payload, 'utf8');
}

/**
 * Sign manifest with Ed25519 private key
 */
export function signManifest(manifest: SkillManifest, privateKey: string): SignedManifest {
  // Set public key from private key if not already set
  if (!manifest.publicKey) {
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    manifest.publicKey = publicKey;
  }

  const payload = computeManifestHash(manifest);
  const signature = sign(null, payload, privateKey);

  return {
    ...manifest,
    signature: signature.toString('base64')
  };
}

/**
 * Verify manifest signature using embedded public key
 */
export function verifyManifest(signed: SignedManifest): boolean {
  try {
    // Validate schema
    SignedManifestSchema.parse(signed);

    const payload = computeManifestHash(signed);
    const signature = Buffer.from(signed.signature, 'base64');

    return verify(null, payload, signed.publicKey, signature);
  } catch (error) {
    return false;
  }
}

// ============================================================================
// INTEGRITY VERIFICATION
// ============================================================================

/**
 * Verify skill directory matches signed manifest
 * Returns list of tampered files (empty if valid)
 */
export async function verifySkillIntegrity(
  skillDir: string,
  signed: SignedManifest
): Promise<{ valid: boolean; tamperedFiles: string[] }> {
  // First verify signature
  if (!verifyManifest(signed)) {
    return { valid: false, tamperedFiles: ['__SIGNATURE_INVALID__'] };
  }

  const tamperedFiles: string[] = [];

  // Re-hash all files and compare to manifest
  for (const fileEntry of signed.files) {
    const fullPath = join(skillDir, fileEntry.path);

    try {
      const currentHash = await hashFile(fullPath);
      if (currentHash !== fileEntry.sha256) {
        tamperedFiles.push(fileEntry.path);
      }
    } catch (error) {
      // File missing or unreadable
      tamperedFiles.push(fileEntry.path);
    }
  }

  // Check for unexpected files
  const currentFiles = await walkDirectory(skillDir);
  const manifestPaths = new Set(signed.files.map(f => f.path));

  for (const filePath of currentFiles) {
    if (!manifestPaths.has(filePath)) {
      tamperedFiles.push(`__EXTRA__:${filePath}`);
    }
  }

  return {
    valid: tamperedFiles.length === 0,
    tamperedFiles
  };
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Load and parse signed manifest from JSON file
 */
export async function loadSignedManifest(manifestPath: string): Promise<SignedManifest> {
  const contents = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(contents);
  return SignedManifestSchema.parse(parsed);
}

/**
 * Check if skill directory has been modified since signing
 * Useful for hot-reload scenarios
 */
export async function needsReVerification(
  skillDir: string,
  signed: SignedManifest
): Promise<boolean> {
  // Quick check: compare file count first
  const currentFiles = await walkDirectory(skillDir);
  if (currentFiles.length !== signed.files.length) {
    return true;
  }

  // Check modification times (heuristic - not cryptographically secure)
  for (const fileEntry of signed.files) {
    const fullPath = join(skillDir, fileEntry.path);
    try {
      const stats = await stat(fullPath);
      if (stats.mtimeMs > signed.timestamp) {
        return true;
      }
    } catch {
      return true; // File missing
    }
  }

  return false;
}
