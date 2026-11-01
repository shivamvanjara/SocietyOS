import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';

async function api(path, { method = 'GET', body, csrfToken } = {}) {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error?.message || 'Something went wrong. Please try again.');
  return payload;
}

export default function MfaSettings({ csrfToken }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const status = useQuery({ queryKey: ['mfa-status'], queryFn: () => api('/auth/mfa') });

  useEffect(() => {
    let current = true;
    if (!enrollment) {
      setQr('');
      return undefined;
    }
    QRCode.toDataURL(enrollment.otpauthUrl, { width: 220, margin: 2 })
      .then((dataUrl) => {
        if (current) setQr(dataUrl);
      })
      .catch(() => {
        if (current)
          setError(
            'Could not make a setup QR. Use the displayed secret in your authenticator app.',
          );
      });
    return () => {
      current = false;
    };
  }, [enrollment]);

  const enroll = useMutation({
    mutationFn: () => api('/auth/mfa/enroll', { method: 'POST', csrfToken, body: { password } }),
    onSuccess: (result) => {
      setEnrollment(result);
      setPassword('');
      setCode('');
      setError('');
    },
    onError: (cause) => setError(cause.message),
  });
  const confirm = useMutation({
    mutationFn: () => api('/auth/mfa/confirm', { method: 'POST', csrfToken, body: { code } }),
    onSuccess: async () => {
      setEnrollment(null);
      setCode('');
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['mfa-status'] });
    },
    onError: (cause) => setError(cause.message),
  });
  const disable = useMutation({
    mutationFn: () =>
      api('/auth/mfa/disable', { method: 'POST', csrfToken, body: { password, code } }),
    onSuccess: async () => {
      setPassword('');
      setCode('');
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['mfa-status'] });
    },
    onError: (cause) => setError(cause.message),
  });

  if (status.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading security settings…
      </section>
    );
  if (status.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load security settings</h2>
        <p>{status.error.message}</p>
        <button className="button secondary" onClick={() => status.refetch()}>
          Try again
        </button>
      </section>
    );
  if (!status.data.eligible && !status.data.enabled)
    return (
      <section className="state-panel">
        <h2>Administrator access required</h2>
        <p>
          Multi-factor authentication settings are available to society and platform administrators.
        </p>
      </section>
    );

  return (
    <div className="security-settings">
      <section className="section-heading">
        <div>
          <p className="eyebrow">ACCOUNT SECURITY</p>
          <h2>Multi-factor authentication</h2>
          <p>Use an authenticator app to protect administrator sign-ins.</p>
        </div>
        <span className={`complaint-state ${status.data.enabled ? 'secure-state' : ''}`}>
          {status.data.enabled ? 'Enabled' : 'Not enabled'}
        </span>
      </section>
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {!status.data.enabled && !enrollment && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            enroll.mutate();
          }}
        >
          <h3>Set up an authenticator app</h3>
          <p>
            Confirm your password before starting setup. The QR code is temporary and expires after
            15 minutes.
          </p>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="button primary" disabled={enroll.isPending}>
            {enroll.isPending ? 'Preparing setup…' : 'Set up MFA'}
          </button>
        </form>
      )}
      {!status.data.enabled && enrollment && (
        <section className="form-card resident-form mfa-enrollment">
          <h3>Scan this QR with your authenticator app</h3>
          <p>Then enter the current six-digit code to finish enabling MFA.</p>
          {qr ? <img src={qr} alt="Authenticator setup QR code" /> : <span className="spinner" />}
          <p className="mfa-secret-label">Manual setup key</p>
          <code>{enrollment.secret}</code>
          <small>Setup expires {new Date(enrollment.expiresAt).toLocaleTimeString()}.</small>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError('');
              confirm.mutate();
            }}
          >
            <label className="field">
              <span>Authenticator code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
              />
            </label>
            <button className="button primary" disabled={confirm.isPending || code.length !== 6}>
              {confirm.isPending ? 'Verifying…' : 'Verify and enable'}
            </button>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => {
                setEnrollment(null);
                setCode('');
                setError('');
              }}
            >
              Cancel setup
            </button>
          </form>
        </section>
      )}
      {status.data.enabled && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            disable.mutate();
          }}
        >
          <h3>Disable multi-factor authentication</h3>
          <p>
            Confirm your password and current authenticator code. Other active sessions will be
            revoked.
          </p>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Authenticator code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
            />
          </label>
          <button className="button secondary" disabled={disable.isPending || code.length !== 6}>
            {disable.isPending ? 'Disabling…' : 'Disable MFA'}
          </button>
        </form>
      )}
    </div>
  );
}
