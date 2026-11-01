import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { tokensMatch } from './security.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const associatedData = Buffer.from('societyos-totp-secret-v1');

function secretKey() {
  return env.MFA_ENCRYPTION_KEY
    ? Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64url')
    : createHash('sha256').update(`${env.SESSION_SECRET}:societyos-mfa-v1`).digest();
}

function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(secret) {
  const normalized = secret.toUpperCase().replace(/=+$/u, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of normalized) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid MFA secret');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function createTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function encryptTotpSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptTotpSecret(encrypted) {
  const stored = Buffer.from(encrypted, 'base64url');
  if (stored.length < 29) throw new Error('Invalid encrypted MFA secret');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), stored.subarray(0, 12));
  decipher.setAAD(associatedData);
  decipher.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString('utf8');
}

export function hashMfaChallenge(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createTotpCode(secret, time = Date.now()) {
  const counter = BigInt(Math.floor(time / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest.at(-1) & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function matchTotpStep(secret, code, time = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return null;
  const currentStep = Math.floor(time / 30_000);
  for (const window of [-1, 0, 1]) {
    const step = currentStep + window;
    if (step >= 0 && tokensMatch(createTotpCode(secret, step * 30_000), code)) return step;
  }
  return null;
}

export function verifyTotpCode(secret, code, time = Date.now()) {
  return matchTotpStep(secret, code, time) !== null;
}
