import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

async function api(path, { method = 'GET', body, csrfToken } = {}) {
  const response = await fetch(path, {
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
    throw new Error(payload.error?.message || 'Could not update Razorpay settings.');
  return payload;
}

export default function RazorpayAccountPanel({ society, csrfToken }) {
  const path = `/api/v1/societies/${society.id}/billing/razorpay-account`;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ keyId: '', keySecret: '', webhookSecret: '' });
  const [error, setError] = useState('');
  const accountQuery = useQuery({
    queryKey: ['razorpay-account', society.id],
    queryFn: () => api(path),
  });
  const saveMutation = useMutation({
    mutationFn: (body) => api(path, { method: 'PUT', csrfToken, body }),
    onSuccess: (result) => {
      queryClient.setQueryData(['razorpay-account', society.id], result);
      queryClient.invalidateQueries({ queryKey: ['payment-status', society.id] });
      setForm({ keyId: '', keySecret: '', webhookSecret: '' });
      setError('');
    },
    onError: (cause) => setError(cause.message),
  });

  if (accountQuery.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading Razorpay settings…
      </section>
    );
  if (accountQuery.isError)
    return (
      <section className="state-panel error-state">
        <h2>Razorpay settings unavailable</h2>
        <p>{accountQuery.error.message}</p>
        <button className="button secondary" onClick={() => accountQuery.refetch()}>
          Try again
        </button>
      </section>
    );

  const account = accountQuery.data.paymentAccount;
  return (
    <section className="form-card razorpay-account-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ONLINE COLLECTIONS</p>
          <h2>Society Razorpay account</h2>
          <p>
            Residents pay through your own Razorpay merchant account. Razorpay settles funds to the
            bank account registered with that merchant.
          </p>
        </div>
        <span className={`occupancy ${account.configured ? 'occupied' : 'vacant'}`}>
          {account.configured ? 'Connected' : 'Not connected'}
        </span>
      </div>
      {account.configured && (
        <p className="muted">
          {account.keyId.startsWith('rzp_test_') ? 'Test mode' : 'Live mode'} · {account.keyId}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          saveMutation.mutate({ enabled: true, ...form });
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>Razorpay Key ID</span>
            <input
              autoComplete="off"
              placeholder="rzp_test_… or rzp_live_…"
              value={form.keyId}
              onChange={(event) => setForm({ ...form, keyId: event.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Razorpay Key Secret</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.keySecret}
              onChange={(event) => setForm({ ...form, keySecret: event.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Payment Webhook Secret</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.webhookSecret}
              onChange={(event) => setForm({ ...form, webhookSecret: event.target.value })}
              required
            />
          </label>
        </div>
        <p className="muted razorpay-account-help">
          Secrets are encrypted before saving and are never shown again. First connect Razorpay test
          keys. Add the payment webhook at your API URL with path{' '}
          <code>/api/v1/payments/webhooks/razorpay</code> and subscribe to{' '}
          <code>payment.captured</code> and <code>payment.failed</code>. Each merchant account needs
          its own webhook secret.
        </p>
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="button primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving securely…' : 'Save Razorpay account'}
          </button>
          {account.configured && (
            <button
              className="button secondary"
              type="button"
              disabled={saveMutation.isPending}
              onClick={() => {
                setError('');
                saveMutation.mutate({ enabled: false });
              }}
            >
              Disable online payments
            </button>
          )}
        </div>
        {account.configured && (
          <p className="muted">
            Replacing credentials keeps already-created payment orders tied to the previous key set.
            Disabling stops new online payments while pending orders can still be reconciled.
          </p>
        )}
      </form>
    </section>
  );
}
