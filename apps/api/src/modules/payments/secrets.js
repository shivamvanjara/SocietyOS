import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

function encryptionKey(key) {
  const configuredKey = key ?? env.RAZORPAY_ACCOUNT_ENCRYPTION_KEY;
  if (!configuredKey && env.NODE_ENV !== 'production') {
    return Buffer.from(
      hkdfSync('sha256', env.SESSION_SECRET, 'societyos-local', 'razorpay-account-secrets', 32),
    );
  }
  if (!configuredKey) throw new Error('Razorpay account encryption is not configured');
  const bytes = Buffer.from(configuredKey, 'base64url');
  if (bytes.length !== 32) throw new Error('Razorpay account encryption key is invalid');
  return bytes;
}

export function razorpayAccountEncryptionConfigured() {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptRazorpaySecret(secret, key) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('A secret is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptRazorpaySecret(encryptedSecret, key) {
  if (typeof encryptedSecret !== 'string') throw new TypeError('An encrypted secret is required');
  const [version, encodedIv, encodedTag, encodedSecret, ...extra] = encryptedSecret.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedSecret || extra.length)
    throw new Error('Encrypted Razorpay secret is invalid');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(key),
    Buffer.from(encodedIv, 'base64url'),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedSecret, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function societyRazorpayCredentials(account) {
  if (!account) return null;
  return {
    id: account.id,
    keyId: account.keyId,
    keySecret: decryptRazorpaySecret(account.apiSecretEncrypted),
    webhookSecret: decryptRazorpaySecret(account.webhookSecretEncrypted),
  };
}
