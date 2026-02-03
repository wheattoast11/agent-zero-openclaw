/**
 * JWT Verifier for Supabase tokens.
 * Uses HMAC-SHA256 with shared JWT secret (from Supabase project settings).
 */

import { createHmac } from 'crypto';

export interface VerifiedUser {
  userId: string;
  email: string;
  metadata?: Record<string, unknown>;
}

function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function verifyUserToken(jwt: string): VerifiedUser | null {
  const secret = process.env['SUPABASE_JWT_SECRET'];
  if (!secret) return null;

  const parts = jwt.split('.');
  if (parts.length !== 3) return null;

  try {
    // Verify signature
    const signatureInput = `${parts[0]}.${parts[1]}`;
    const expectedSig = base64UrlEncode(
      createHmac('sha256', secret).update(signatureInput).digest()
    );

    // Timing-safe comparison
    if (expectedSig.length !== parts[2].length) return null;
    const a = Buffer.from(expectedSig);
    const b = Buffer.from(parts[2]);
    if (a.length !== b.length) return null;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    if (diff !== 0) return null;

    // Decode payload
    const payload = JSON.parse(base64UrlDecode(parts[1])) as {
      sub?: string;
      email?: string;
      exp?: number;
      iss?: string;
      aud?: string;
      user_metadata?: Record<string, unknown>;
    };

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Check required fields
    if (!payload.sub) return null;

    return {
      userId: payload.sub,
      email: payload.email ?? '',
      metadata: payload.user_metadata,
    };
  } catch {
    return null;
  }
}
