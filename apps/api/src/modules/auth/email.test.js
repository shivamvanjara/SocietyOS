import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'production',
    EMAIL_API_KEY: 'test-only-resend-key',
    EMAIL_FROM: 'onboarding@resend.dev',
  },
}));

const { sendEmailVerificationEmail, sendPasswordResetEmail } = await import('./email.js');
const testRecipient = process.env.RESEND_TEST_RECIPIENT || 'resend-owner@example.test';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe('Resend transactional email recipients', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends verification email to the supplied owner recipient', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { id: 'email-verification-test-id' }));
    vi.stubGlobal('fetch', fetch);

    const result = await sendEmailVerificationEmail(
      testRecipient,
      'https://societyos.example.test/verify-email?token=test-token',
    );

    expect(result).toEqual({ emailId: 'email-verification-test-id' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      from: 'onboarding@resend.dev',
      to: [testRecipient],
      subject: 'Verify your SocietyOS email address',
    });
  });

  it('sends password-reset email to the supplied owner recipient', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response(200, { data: { id: 'password-reset-test-id' }, error: null }));
    vi.stubGlobal('fetch', fetch);

    const result = await sendPasswordResetEmail(
      testRecipient,
      'https://societyos.example.test/reset-password?token=test-token',
    );

    expect(result).toEqual({ emailId: 'password-reset-test-id' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      from: 'onboarding@resend.dev',
      to: [testRecipient],
      subject: 'Reset your SocietyOS password',
    });
  });

  it.each([null, undefined, '', 'not-an-email'])(
    'never calls Resend for invalid recipient %s',
    async (email) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(
        sendEmailVerificationEmail(email, 'https://example.test/verify'),
      ).rejects.toThrow('Email recipient is invalid');
      await expect(sendPasswordResetEmail(email, 'https://example.test/reset')).rejects.toThrow(
        'Email recipient is invalid',
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('logs only safe provider status and error code on rejected requests', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(422, {
        error: { name: 'validation_error', message: 'Invalid to field: private@example.com' },
      }),
    );
    const safeLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetch);

    await expect(
      sendPasswordResetEmail(testRecipient, 'https://example.test/reset?token=private-token'),
    ).rejects.toThrow('Email provider rejected the message (422)');

    expect(safeLog).toHaveBeenCalledWith('Resend rejected email request', {
      status: 422,
      providerCode: 'validation_error',
    });
    expect(JSON.stringify(safeLog.mock.calls)).not.toContain(testRecipient);
    expect(JSON.stringify(safeLog.mock.calls)).not.toContain('private-token');
  });
});
