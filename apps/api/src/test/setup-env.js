process.env.NODE_ENV ??= 'test';
process.env.WEB_ORIGIN ??= 'http://localhost:5173';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
process.env.RAZORPAY_ACCOUNT_ENCRYPTION_KEY ??= 'A'.repeat(43);
