import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptRazorpaySecret, encryptRazorpaySecret } from './secrets.js';

const key = randomBytes(32).toString('base64url');

describe('society Razorpay secret encryption', () => {
  it('encrypts secrets with randomized authenticated ciphertext', () => {
    const first = encryptRazorpaySecret('merchant-secret', key);
    const second = encryptRazorpaySecret('merchant-secret', key);

    expect(first).not.toBe(second);
    expect(first).not.toContain('merchant-secret');
    expect(decryptRazorpaySecret(first, key)).toBe('merchant-secret');
  });

  it('rejects corrupted ciphertext and the wrong encryption key', () => {
    const encrypted = encryptRazorpaySecret('merchant-secret', key);

    expect(() => decryptRazorpaySecret(`${encrypted}corrupt`, key)).toThrow();
    expect(() => decryptRazorpaySecret(encrypted, randomBytes(32).toString('base64url'))).toThrow();
  });
});
