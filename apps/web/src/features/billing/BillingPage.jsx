import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PaymentInstructionsPanel from './PaymentInstructionsPanel.jsx';
import RazorpayAccountPanel from './RazorpayAccountPanel.jsx';

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

async function uploadInvoiceDocument(root, csrfToken, invoiceId, file) {
  const response = await fetch(`${root}/billing/${invoiceId}/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type,
      'X-File-Name': encodeURIComponent(file.name),
      'X-CSRF-Token': csrfToken,
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error?.message || 'Bill document upload failed. Please try again.');
  return payload;
}

const dateInput = () => new Date().toISOString().slice(0, 10);
const monthInput = () => new Date().toISOString().slice(0, 7);

async function fetchAll(path, property) {
  const records = [];
  let cursor;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const result = await api(`${path}${separator}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    records.push(...result[property]);
    cursor = result.nextCursor;
  } while (cursor);
  return records;
}

export default function BillingPage({ society, csrfToken, canManage, canConfigurePaymentDetails }) {
  const root = `/societies/${society.id}`;
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [paymentFor, setPaymentFor] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [generation, setGeneration] = useState({
    description: 'Monthly maintenance',
    period: monthInput(),
    amount: '',
    dueDate: dateInput(),
    scope: 'OCCUPIED',
  });
  const [charge, setCharge] = useState({
    flatId: '',
    description: 'Monthly maintenance',
    period: monthInput(),
    amount: '',
    dueDate: dateInput(),
  });
  const [payment, setPayment] = useState({
    amount: '',
    method: 'UPI',
    reference: '',
    receivedAt: new Date().toISOString().slice(0, 16),
  });
  const buildingsQuery = useQuery({
    queryKey: ['billing-buildings', society.id],
    queryFn: async () => ({ buildings: await fetchAll(`${root}/buildings`, 'buildings') }),
    enabled: canManage,
  });
  const buildings = buildingsQuery.data?.buildings ?? [];
  const flatsQuery = useQuery({
    queryKey: ['billing-flats', society.id, buildings.map(({ id }) => id)],
    enabled: canManage && buildings.length > 0,
    queryFn: async () =>
      (
        await Promise.all(
          buildings.map(async (building) => {
            const flats = await fetchAll(`${root}/buildings/${building.id}/flats`, 'flats');
            return flats.map((flat) => ({ ...flat, buildingName: building.name }));
          }),
        )
      ).flat(),
  });
  const invoicesQuery = useQuery({
    queryKey: ['billing', society.id],
    queryFn: async () => ({ invoices: await fetchAll(`${root}/billing`, 'invoices') }),
    enabled: canManage,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['billing', society.id] });
  const issueMutation = useMutation({
    mutationFn: () =>
      api(`${root}/billing`, {
        method: 'POST',
        csrfToken,
        body: charge,
      }),
    onSuccess: () => {
      setShowForm(false);
      setCharge({ ...charge, flatId: '', amount: '' });
      setError('');
      refresh();
    },
    onError: (e) => setError(e.message),
  });
  const generationMutation = useMutation({
    mutationFn: () =>
      api(`${root}/billing/generate`, {
        method: 'POST',
        csrfToken,
        body: generation,
      }),
    onSuccess: (result) => {
      setShowGenerateForm(false);
      setError('');
      setSuccess(
        `${result.createdCount} charge${result.createdCount === 1 ? '' : 's'} created; ${result.skippedCount} duplicate${result.skippedCount === 1 ? '' : 's'} skipped.`,
      );
      refresh();
    },
    onError: (cause) => {
      setSuccess('');
      setError(cause.message);
    },
  });
  const paymentMutation = useMutation({
    mutationFn: () =>
      api(`${root}/billing/${paymentFor.id}/payments`, {
        method: 'POST',
        csrfToken,
        body: { ...payment, receivedAt: new Date(payment.receivedAt).toISOString() },
      }),
    onSuccess: () => {
      setPaymentFor(null);
      setPayment({ ...payment, amount: '', reference: '' });
      setError('');
      refresh();
    },
    onError: (e) => setError(e.message),
  });
  const uploadMutation = useMutation({
    mutationFn: ({ invoice, file }) => uploadInvoiceDocument(root, csrfToken, invoice.id, file),
    onSuccess: async () => {
      setError('');
      setSuccess('Bill document uploaded.');
      await refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const invoices = invoicesQuery.data?.invoices ?? [];
  const outstanding = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
  const collected = invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0);
  const flatName = (invoice) => `${invoice.flat.building.name} · ${invoice.flat.flatNumber}`;

  if (!canManage)
    return (
      <section className="state-panel">
        <h2>Administrator access required</h2>
        <p>Billing records are visible to society administrators.</p>
      </section>
    );
  if (invoicesQuery.isPending || buildingsQuery.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading billing…
      </section>
    );
  if (invoicesQuery.isError || buildingsQuery.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load billing</h2>
        <p>{invoicesQuery.error?.message || buildingsQuery.error?.message}</p>
        <button
          className="button secondary"
          onClick={() => {
            invoicesQuery.refetch();
            buildingsQuery.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );

  return (
    <div className="residents-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">ACCOUNTS</p>
          <h2>Charges & payments</h2>
          <p>Issue flat charges, record receipts, and track the outstanding balance.</p>
        </div>
        <div className="form-actions">
          <button
            className="button secondary"
            onClick={() => {
              setError('');
              setSuccess('');
              setShowGenerateForm(!showGenerateForm);
              setShowForm(false);
            }}
          >
            Generate monthly charges
          </button>
          <button
            className="button primary"
            onClick={() => {
              setError('');
              setSuccess('');
              setShowForm(!showForm);
              setShowGenerateForm(false);
            }}
          >
            ＋ Issue one charge
          </button>
        </div>
      </section>
      {success && (
        <div className="success-message" role="status">
          {success}
          <button onClick={() => setSuccess('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <section className="data-summary billing-summary">
        <div>
          <span>Outstanding</span>
          <b>₹{outstanding.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>
        </div>
        <div>
          <span>Collected</span>
          <b>₹{collected.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>
        </div>
        <div>
          <span>Open charges</span>
          <b>{invoices.filter((invoice) => invoice.balance > 0).length}</b>
        </div>
      </section>
      {canManage && (
        <PaymentInstructionsPanel
          society={society}
          csrfToken={csrfToken}
          canEdit={canConfigurePaymentDetails}
        />
      )}
      {canConfigurePaymentDetails && (
        <RazorpayAccountPanel society={society} csrfToken={csrfToken} />
      )}
      {showGenerateForm && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            generationMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Generate monthly charges</h3>
              <p>Duplicate charges for the same home, period, and description are skipped.</p>
            </div>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setShowGenerateForm(false)}
            >
              Cancel
            </button>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>
                Description <b>*</b>
              </span>
              <input
                required
                maxLength={200}
                value={generation.description}
                onChange={(event) =>
                  setGeneration({ ...generation, description: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>
                Billing period <b>*</b>
              </span>
              <input
                type="month"
                required
                value={generation.period}
                onChange={(event) => setGeneration({ ...generation, period: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Amount per flat (₹) <b>*</b>
              </span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                value={generation.amount}
                onChange={(event) => setGeneration({ ...generation, amount: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Due date <b>*</b>
              </span>
              <input
                type="date"
                required
                value={generation.dueDate}
                onChange={(event) => setGeneration({ ...generation, dueDate: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Homes billed <b>*</b>
              </span>
              <select
                value={generation.scope}
                onChange={(event) => setGeneration({ ...generation, scope: event.target.value })}
              >
                <option value="OCCUPIED">Occupied homes</option>
                <option value="ALL">All homes</option>
              </select>
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={generationMutation.isPending}>
            {generationMutation.isPending ? 'Generating…' : 'Generate charges'}
          </button>
        </form>
      )}
      {showForm && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            issueMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Issue a flat charge</h3>
              <p>A charge is visible to administrators and can accept multiple partial payments.</p>
            </div>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>
                Flat <b>*</b>
              </span>
              <select
                required
                value={charge.flatId}
                onChange={(e) => setCharge({ ...charge, flatId: e.target.value })}
              >
                <option value="">Choose flat</option>
                {(flatsQuery.data ?? []).map((flat) => (
                  <option key={flat.id} value={flat.id}>
                    {flat.buildingName} · {flat.flatNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                Description <b>*</b>
              </span>
              <input
                required
                maxLength={200}
                value={charge.description}
                onChange={(e) => setCharge({ ...charge, description: e.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Billing period <b>*</b>
              </span>
              <input
                type="month"
                required
                value={charge.period}
                onChange={(e) => setCharge({ ...charge, period: e.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Amount (₹) <b>*</b>
              </span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                value={charge.amount}
                onChange={(e) => setCharge({ ...charge, amount: e.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Due date <b>*</b>
              </span>
              <input
                type="date"
                required
                value={charge.dueDate}
                onChange={(e) => setCharge({ ...charge, dueDate: e.target.value })}
              />
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary"
            disabled={issueMutation.isPending || flatsQuery.isPending || !flatsQuery.data?.length}
          >
            {issueMutation.isPending ? 'Issuing…' : 'Issue charge'}
          </button>
          {flatsQuery.isError && <p className="form-message">{flatsQuery.error.message}</p>}
        </form>
      )}
      {paymentFor && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            paymentMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Record payment · {flatName(paymentFor)}</h3>
              <p>Balance due: ₹{paymentFor.balance.toFixed(2)}</p>
            </div>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setPaymentFor(null)}
            >
              Cancel
            </button>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>
                Amount (₹) <b>*</b>
              </span>
              <input
                type="number"
                min="0.01"
                max={paymentFor.balance}
                step="0.01"
                required
                value={payment.amount}
                onChange={(e) => setPayment({ ...payment, amount: e.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Method <b>*</b>
              </span>
              <select
                value={payment.method}
                onChange={(e) => setPayment({ ...payment, method: e.target.value })}
              >
                {['UPI', 'CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'].map((method) => (
                  <option key={method} value={method}>
                    {method.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reference</span>
              <input
                maxLength={100}
                value={payment.reference}
                onChange={(e) => setPayment({ ...payment, reference: e.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Received at <b>*</b>
              </span>
              <input
                type="datetime-local"
                required
                value={payment.receivedAt}
                onChange={(e) => setPayment({ ...payment, receivedAt: e.target.value })}
              />
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={paymentMutation.isPending}>
            {paymentMutation.isPending ? 'Saving…' : 'Record payment'}
          </button>
        </form>
      )}
      {invoices.length === 0 ? (
        <section className="state-panel">
          <h2>No charges yet</h2>
          <p>Issue a charge for a flat to start tracking collections.</p>
        </section>
      ) : (
        <section className="resident-table-panel">
          <div className="table-overflow">
            <table className="flat-table resident-table">
              <thead>
                <tr>
                  <th>Flat</th>
                  <th>Charge</th>
                  <th>Period</th>
                  <th>Amount</th>
                  <th>Paid</th>
                  <th>Balance</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <strong>{flatName(invoice)}</strong>
                    </td>
                    <td>
                      {invoice.description}
                      <small>Due {new Date(invoice.dueDate).toLocaleDateString()}</small>
                      {(invoice.attachments?.length > 0 || canManage) && (
                        <div className="expense-documents">
                          {(invoice.attachments ?? []).map((attachment) => (
                            <a
                              key={attachment.id}
                              href={`${root}/billing/${invoice.id}/attachments/${attachment.id}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {attachment.originalName}
                            </a>
                          ))}
                          {canManage && (invoice.attachments ?? []).length < 10 && (
                            <label className="text-button expense-upload">
                              {uploadMutation.isPending ? 'Uploading…' : '＋ Add bill document'}
                              <input
                                type="file"
                                accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
                                disabled={uploadMutation.isPending}
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  event.target.value = '';
                                  if (!file) return;
                                  if (file.size > 5 * 1024 * 1024) {
                                    setError('Bill documents must be 5 MB or smaller.');
                                    return;
                                  }
                                  setError('');
                                  uploadMutation.mutate({ invoice, file });
                                }}
                              />
                            </label>
                          )}
                        </div>
                      )}
                    </td>
                    <td>{invoice.period}</td>
                    <td>₹{invoice.amount.toFixed(2)}</td>
                    <td>
                      ₹{invoice.paidAmount.toFixed(2)}
                      {invoice.payments.length > 0 && (
                        <small>
                          {invoice.payments.length} receipt{invoice.payments.length > 1 ? 's' : ''}
                        </small>
                      )}
                    </td>
                    <td>
                      <strong>₹{invoice.balance.toFixed(2)}</strong>
                    </td>
                    <td>
                      <span
                        className={`occupancy ${invoice.balance === 0 ? 'occupied' : 'vacant'}`}
                      >
                        {invoice.balance === 0
                          ? 'Paid'
                          : invoice.status === 'PARTIAL'
                            ? 'Partial'
                            : 'Due'}
                      </span>
                    </td>
                    <td>
                      {invoice.balance > 0 && (
                        <button
                          className="button secondary compact"
                          onClick={() => {
                            setError('');
                            setPaymentFor(invoice);
                            setPayment({ ...payment, amount: invoice.balance.toFixed(2) });
                          }}
                        >
                          Record payment
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
