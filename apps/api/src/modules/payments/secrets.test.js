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
    expect(Buffer.from(first.split('.')[2], 'base64url')).toHaveLength(16);
  });

  it('rejects incorrect authentication tags and the wrong encryption key', () => {
    const encrypted = encryptRazorpaySecret('merchant-secret', key);
    const parts = encrypted.split('.');
    const tag = Buffer.from(parts[2], 'base64url');
    tag[0] ^= 1;
    parts[2] = tag.toString('base64url');

    expect(() => decryptRazorpaySecret(parts.join('.'), key)).toThrow();
    expect(() => decryptRazorpaySecret(encrypted, randomBytes(32).toString('base64url'))).toThrow();
  });

  it('rejects malformed ciphertext, IVs and authentication tag lengths', () => {
    const parts = encryptRazorpaySecret('merchant-secret', key).split('.');
    expect(() => decryptRazorpaySecret(`${parts.join('.')}extra`, key)).toThrow();
    expect(() => decryptRazorpaySecret('v1.invalid.iv.ciphertext', key)).toThrow();

    const badIv = [...parts];
    badIv[1] = randomBytes(11).toString('base64url');
    expect(() => decryptRazorpaySecret(badIv.join('.'), key)).toThrow();

    const badTag = [...parts];
    badTag[2] = randomBytes(12).toString('base64url');
    expect(() => decryptRazorpaySecret(badTag.join('.'), key)).toThrow();
  });
});
