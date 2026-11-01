import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { env } from '../../config/env.js';

export const SESSION_COOKIE =
  env.NODE_ENV === 'production' ? '__Host-societyos_session' : 'societyos_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const argon2Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createCsrfToken(sessionToken) {
  return createHmac('sha256', env.SESSION_SECRET).update(sessionToken).digest('base64url');
}

export function tokensMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function hashPassword(password) {
  // Argon2id is the package default; keep the cost policy explicit.
  return hash(password, argon2Options);
}

export function verifyPassword(passwordHash, password) {
  return verify(passwordHash, password);
}
