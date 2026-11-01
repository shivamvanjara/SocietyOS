import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

function date(value) {
  return value ? new Date(value).toLocaleDateString() : '—';
}

export default function SubscriptionPage({ society, csrfToken }) {
  const [planId, setPlanId] = useState('');
  const [consented, setConsented] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const key = ['society-subscription', society.id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api(`/societies/${society.id}/subscription`),
  });
  const checkout = useMutation({
    mutationFn: () =>
      api(`/societies/${society.id}/subscription/checkout`, {
        method: 'POST',
        csrfToken,
        body: { planId },
      }),
    onSuccess: async (result) => {
      setCheckoutUrl(result.checkoutUrl);
      setError('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (cause) => setError(cause.message),
  });
  const cancel = useMutation({
    mutationFn: () =>
      api(`/societies/${society.id}/subscription/${subscription.id}/cancel`, {
        method: 'POST',
        csrfToken,
      }),
    onSuccess: async () => {
      setCheckoutUrl('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (cause) => setError(cause.message),
  });

  if (query.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading subscription…
      </section>
    );
  if (query.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load subscription details</h2>
        <p>{query.error.message}</p>
        <button className="button secondary" onClick={() => query.refetch()}>
          Try again
        </button>
      </section>
    );

  const { subscription, plans, razorpayConfigured } = query.data;
  const availablePlans = plans.filter(
    (plan) => plan.id === subscription?.planId || plan.active !== false,
  );
  const active = ['ACTIVE', 'TRIAL', 'PAST_DUE'].includes(subscription?.status);
  const pendingCheckout = subscription?.status === 'PENDING' && subscription?.checkoutUrl;
  const selectedPlan = plans.find((plan) => plan.id === planId);

  return (
    <div className="subscription-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">SOCIETY ACCOUNT</p>
          <h2>Subscription &amp; billing</h2>
          <p>Manage the SocietyOS plan for {society.name}.</p>
        </div>
      </section>
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}

      {subscription ? (
        <section className="form-card">
          <div className="section-heading">
            <div>
              <h3>Current subscription</h3>
              <p>
                {subscription.plan?.name} · ₹{subscription.price} /{' '}
                {subscription.billingInterval.toLowerCase()}
              </p>
            </div>
            <span className={`status-pill status-${subscription.status.toLowerCase()}`}>
              {subscription.status.replace('_', ' ')}
            </span>
          </div>
          <p>
            {subscription.status === 'PENDING'
              ? subscription.checkoutUrl
                ? 'Complete the secure payment authorization to activate this plan.'
                : 'Your secure checkout is being prepared. Refresh this page shortly.'
              : active
                ? subscription.cancelAtCycleEnd
                  ? `Renewal is canceled. Access remains active through ${date(subscription.endsAt)}.`
                  : `Access is active${subscription.endsAt ? ` through ${date(subscription.endsAt)}` : ''}. Successful renewals are recorded below.`
                : `This subscription ended on ${date(subscription.endsAt)}.`}
          </p>
          {(checkoutUrl || pendingCheckout) && (
            <a
              className="button primary"
              href={checkoutUrl || subscription.checkoutUrl}
              target="_blank"
              rel="noreferrer"
            >
              Continue to secure checkout
            </a>
          )}
          {(['ACTIVE', 'TRIAL', 'PAST_DUE'].includes(subscription.status) &&
            !subscription.cancelAtCycleEnd) ||
          subscription.status === 'PENDING' ? (
            <button
              type="button"
              className="button secondary compact"
              disabled={cancel.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Cancel this subscription? Active access continues until the current billing period ends.',
                  )
                ) {
                  setError('');
                  cancel.mutate();
                }
              }}
            >
              {cancel.isPending ? 'Canceling…' : 'Cancel subscription'}
            </button>
          ) : null}
          {subscription.charges?.length > 0 && (
            <div className="table-overflow">
              <table className="flat-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {subscription.charges.map((charge) => (
                    <tr key={charge.id}>
                      <td>{charge.providerPaymentId}</td>
                      <td>₹{charge.amount}</td>
                      <td>{charge.status}</td>
                      <td>{date(charge.paidAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {!active && !pendingCheckout && availablePlans.length > 0 && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            checkout.mutate();
          }}
        >
          <div>
            <h3>{subscription ? 'Choose a new plan' : 'Choose a plan'}</h3>
            <p>Select an available plan. You’ll confirm payment securely on Razorpay.</p>
          </div>
          <label className="field">
            <span>SocietyOS plan *</span>
            <select required value={planId} onChange={(event) => setPlanId(event.target.value)}>
              <option value="">Select a plan</option>
              {availablePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} · ₹{plan.price} / {plan.billingInterval.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          {selectedPlan?.description && <p>{selectedPlan.description}</p>}
          {!razorpayConfigured && (
            <p className="muted">
              Online subscription checkout is not configured yet. Ask your platform administrator to
              configure Razorpay keys and the subscription webhook.
            </p>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              required
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            <span>
              I authorize recurring charges of ₹{selectedPlan?.price ?? '—'}{' '}
              {selectedPlan
                ? `per ${selectedPlan.billingInterval.toLowerCase()} billing cycle`
                : 'per billing cycle'}{' '}
              until this subscription is canceled.
            </span>
          </label>
          <button
            className="button primary"
            disabled={!razorpayConfigured || !consented || checkout.isPending}
          >
            {checkout.isPending ? 'Preparing secure checkout…' : 'Continue to payment'}
          </button>
        </form>
      )}
      {!subscription && availablePlans.length === 0 && (
        <section className="state-panel">
          <h3>No plans are available</h3>
          <p>Contact your SocietyOS administrator for plan options.</p>
        </section>
      )}
      {checkoutUrl && !pendingCheckout && (
        <section className="success-message" role="status">
          Secure checkout is ready.{' '}
          <a href={checkoutUrl} target="_blank" rel="noreferrer">
            Open Razorpay checkout
          </a>
        </section>
      )}
    </div>
  );
}
