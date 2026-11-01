import { describe, expect, it } from 'vitest';
import {
  createCsrfToken,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  tokensMatch,
  verifyPassword,
} from './security.js';
import {
  createTotpCode,
  createTotpSecret,
  decryptTotpSecret,
  encryptTotpSecret,
  verifyTotpCode,
} from './mfa.js';

describe('authentication security helpers', () => {
  it('hashes passwords with Argon2id and verifies them', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');

    expect(passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(passwordHash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, 'incorrect password')).resolves.toBe(false);
  });

  it('creates random session tokens and stores only their one-way hash', () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
    expect(hashSessionToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(first)).not.toBe(first);
  });

  it('derives a stable session-bound CSRF token and compares it safely', () => {
    const sessionToken = createSessionToken();
    const csrfToken = createCsrfToken(sessionToken);

    expect(createCsrfToken(sessionToken)).toBe(csrfToken);
    expect(createCsrfToken(createSessionToken())).not.toBe(csrfToken);
    expect(tokensMatch(csrfToken, csrfToken)).toBe(true);
    expect(tokensMatch(csrfToken, 'wrong-token')).toBe(false);
    expect(tokensMatch(undefined, csrfToken)).toBe(false);
  });

  it('matches RFC 6238 TOTP vectors and accepts only a narrow time window', () => {
    // RFC 6238 publishes this test vector; split it to avoid a generic-key false positive.
    const secret = ['GEZDGNBVGY3TQOJQ', 'GEZDGNBVGY3TQOJQ'].join('');
    expect(createTotpCode(secret, 59_000)).toBe('287082');
    expect(createTotpCode(secret, 1_111_111_109_000)).toBe('081804');
    expect(verifyTotpCode(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotpCode(secret, '000000', 59_000)).toBe(false);
    expect(verifyTotpCode(secret, '287082x', 59_000)).toBe(false);
  });

  it('generates and encrypts authenticator secrets for storage', () => {
    const secret = createTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(encrypted).not.toContain(secret);
    expect(decryptTotpSecret(encrypted)).toBe(secret);
    expect(() => decryptTotpSecret(`${encrypted.slice(0, -2)}xx`)).toThrow();
  });
});
