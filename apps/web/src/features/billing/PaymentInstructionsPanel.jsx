import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const blankDetails = {
  bankAccountName: '',
  bankAccountNumber: '',
  bankName: '',
  bankIfscCode: '',
  upiId: '',
  instructions: '',
};

async function api(societyId, { method = 'GET', body, csrfToken } = {}) {
  const response = await fetch(`/api/v1/societies/${societyId}/billing/payment-instructions`, {
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
    throw new Error(payload.error?.message || 'Could not load transfer details. Please try again.');
  return payload;
}

export function PaymentInstructionsCard({ details }) {
  if (!details) return null;
  return (
    <section className="form-card transfer-details-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">OFFLINE PAYMENT</p>
          <h3>Transfer to your society</h3>
          <p>Use these details to pay an outstanding maintenance charge by bank transfer or UPI.</p>
        </div>
      </div>
      <dl className="transfer-details-list">
        {details.bankAccountName && (
          <>
            <dt>Account name</dt>
            <dd>{details.bankAccountName}</dd>
          </>
        )}
        {details.bankAccountNumber && (
          <>
            <dt>Account number</dt>
            <dd>{details.bankAccountNumber}</dd>
          </>
        )}
        {details.bankName && (
          <>
            <dt>Bank</dt>
            <dd>{details.bankName}</dd>
          </>
        )}
        {details.bankIfscCode && (
          <>
            <dt>IFSC</dt>
            <dd>{details.bankIfscCode}</dd>
          </>
        )}
        {details.upiId && (
          <>
            <dt>UPI ID</dt>
            <dd>{details.upiId}</dd>
          </>
        )}
      </dl>
      {details.instructions && <p className="transfer-note">{details.instructions}</p>}
      <p className="muted">
        After transferring, share the transaction reference with your society office so it can be
        recorded against your bill.
      </p>
    </section>
  );
}

export default function PaymentInstructionsPanel({ society, csrfToken, canEdit }) {
  const queryClient = useQueryClient();
  const queryKey = ['payment-instructions', society.id];
  const [form, setForm] = useState(blankDetails);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn: () => api(society.id),
  });
  useEffect(() => {
    if (query.data) setForm(query.data.paymentInstructions ?? blankDetails);
  }, [query.data]);
  const update = useMutation({
    mutationFn: () => api(society.id, { method: 'PUT', body: form, csrfToken }),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKey, result);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  if (query.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading transfer details…
      </section>
    );
  if (query.isError)
    return (
      <section className="state-panel error-state">
        <h3>We couldn’t load transfer details</h3>
        <p>{query.error.message}</p>
        <button className="button secondary" onClick={() => query.refetch()}>
          Try again
        </button>
      </section>
    );

  const details = query.data.paymentInstructions;
  if (!canEdit)
    return details ? (
      <PaymentInstructionsCard details={details} />
    ) : (
      <section className="form-card">
        <h3>Bank transfer details</h3>
        <p className="muted">This society has not added bank or UPI details yet.</p>
      </section>
    );

  return (
    <section className="form-card resident-form">
      <div>
        <h3>Society transfer details</h3>
        <p>Residents in this society can use these details to pay bills by bank transfer or UPI.</p>
      </div>
      {details && <PaymentInstructionsCard details={details} />}
      <div className="form-grid">
        <label className="field">
          <span>Account holder name</span>
          <input
            maxLength={160}
            value={form.bankAccountName ?? ''}
            onChange={(event) => setForm({ ...form, bankAccountName: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Account number</span>
          <input
            inputMode="numeric"
            autoComplete="off"
            maxLength={34}
            value={form.bankAccountNumber ?? ''}
            onChange={(event) => setForm({ ...form, bankAccountNumber: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Bank name</span>
          <input
            maxLength={120}
            value={form.bankName ?? ''}
            onChange={(event) => setForm({ ...form, bankName: event.target.value })}
          />
        </label>
        <label className="field">
          <span>IFSC code</span>
          <input
            autoCapitalize="characters"
            maxLength={11}
            value={form.bankIfscCode ?? ''}
            onChange={(event) =>
              setForm({ ...form, bankIfscCode: event.target.value.toUpperCase() })
            }
          />
        </label>
        <label className="field">
          <span>UPI ID (optional)</span>
          <input
            maxLength={100}
            placeholder="society@bank"
            value={form.upiId ?? ''}
            onChange={(event) => setForm({ ...form, upiId: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Payment instructions (optional)</span>
          <textarea
            rows="3"
            maxLength={500}
            value={form.instructions ?? ''}
            onChange={(event) => setForm({ ...form, instructions: event.target.value })}
          />
        </label>
      </div>
      {update.error && (
        <p className="form-message" role="alert">
          {update.error.message}
        </p>
      )}
      {saved && (
        <p className="success-message" role="status">
          Transfer details saved.
        </p>
      )}
      <button
        className="button primary"
        disabled={update.isPending}
        onClick={() => {
          setSaved(false);
          update.mutate();
        }}
      >
        {update.isPending ? 'Saving…' : 'Save transfer details'}
      </button>
    </section>
  );
}
