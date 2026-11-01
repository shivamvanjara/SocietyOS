import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce
      .number()
      .int()
      .positive()
      .default(process.env.PORT ?? 4000),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    WEB_ORIGIN: z
      .url()
      .transform((value) => new URL(value).origin)
      .default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    MFA_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .optional(),
    ),
    RAZORPAY_KEY_ID: optionalSecret,
    RAZORPAY_KEY_SECRET: optionalSecret,
    RAZORPAY_WEBHOOK_SECRET: optionalSecret,
    RAZORPAY_ACCOUNT_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .optional(),
    ),
    RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET: optionalSecret,
    EMAIL_API_KEY: optionalSecret,
    EMAIL_FROM: optionalSecret,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && (!value.EMAIL_API_KEY || !value.EMAIL_FROM)) {
      context.addIssue({
        code: 'custom',
        message: 'EMAIL_API_KEY and EMAIL_FROM are required in production',
        path: ['EMAIL_API_KEY'],
      });
    }
    if (value.NODE_ENV === 'production' && !value.MFA_ENCRYPTION_KEY) {
      context.addIssue({
        code: 'custom',
        message: 'MFA_ENCRYPTION_KEY must be a base64url-encoded 32-byte key in production',
        path: ['MFA_ENCRYPTION_KEY'],
      });
    }
    if (value.NODE_ENV === 'production' && !value.RAZORPAY_ACCOUNT_ENCRYPTION_KEY) {
      context.addIssue({
        code: 'custom',
        message:
          'RAZORPAY_ACCOUNT_ENCRYPTION_KEY must be a base64url-encoded 32-byte key in production',
        path: ['RAZORPAY_ACCOUNT_ENCRYPTION_KEY'],
      });
    }
  });

export const env = envSchema.parse(process.env);
