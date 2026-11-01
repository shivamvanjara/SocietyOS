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

async function uploadDocument(path, csrfToken, expenseId, file) {
  const response = await fetch(`${path}/${expenseId}/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type,
      'X-CSRF-Token': csrfToken,
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error?.message || 'Document upload failed. Please try again.');
  return payload;
}

const today = () => new Date().toISOString().slice(0, 10);

async function fetchAll(path) {
  const expenses = [];
  let cursor;
  do {
    const result = await api(`${path}?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    expenses.push(...result.expenses);
    cursor = result.nextCursor;
  } while (cursor);
  return expenses;
}

export default function ExpensesPage({ society, csrfToken, canManage, canApprove }) {
  const root = `/societies/${society.id}/expenses`;
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reviewReasons, setReviewReasons] = useState({});
  const [form, setForm] = useState({
    category: 'Maintenance',
    description: '',
    vendor: '',
    amount: '',
    spentAt: today(),
    reference: '',
  });
  const expensesQuery = useQuery({
    queryKey: ['expenses', society.id],
    queryFn: async () => ({ expenses: await fetchAll(root) }),
    enabled: canManage,
  });
  const mutation = useMutation({
    mutationFn: () =>
      api(root, {
        method: 'POST',
        csrfToken,
        body: { ...form, vendor: form.vendor || null, reference: form.reference || null },
      }),
    onSuccess: async () => {
      setShowForm(false);
      setError('');
      setMessage('Expense submitted for administrator review.');
      setForm({ ...form, description: '', vendor: '', amount: '', reference: '' });
      await queryClient.invalidateQueries({ queryKey: ['expenses', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const uploadMutation = useMutation({
    mutationFn: ({ expense, file }) => uploadDocument(root, csrfToken, expense.id, file),
    onSuccess: async () => {
      setError('');
      setMessage('Bill document uploaded.');
      await queryClient.invalidateQueries({ queryKey: ['expenses', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const reviewMutation = useMutation({
    mutationFn: ({ expense, action, reason }) =>
      api(`${root}/${expense.id}/${action}`, {
        method: 'POST',
        csrfToken,
        body: action === 'reject' ? { reason } : {},
      }),
    onSuccess: async (_result, variables) => {
      setError('');
      setMessage(`Expense ${variables.action === 'approve' ? 'approved' : 'rejected'}.`);
      setReviewReasons({ ...reviewReasons, [variables.expense.id]: '' });
      await queryClient.invalidateQueries({ queryKey: ['expenses', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  if (!canManage)
    return (
      <section className="state-panel">
        <h2>Administrator or accountant access required</h2>
        <p>Expense records contain society financial information.</p>
      </section>
    );
  if (expensesQuery.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading expenses…
      </section>
    );
  if (expensesQuery.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load expenses</h2>
        <p>{expensesQuery.error.message}</p>
        <button className="button secondary" onClick={() => expensesQuery.refetch()}>
          Try again
        </button>
      </section>
    );
  const expenses = expensesQuery.data.expenses;
  const totalExpenses = expenses
    .filter((expense) => expense.status === 'APPROVED')
    .reduce((sum, expense) => sum + expense.amount, 0);
  const pendingExpenses = expenses
    .filter((expense) => expense.status === 'SUBMITTED')
    .reduce((sum, expense) => sum + expense.amount, 0);
  return (
    <div className="residents-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">ACCOUNTS</p>
          <h2>Society expenses</h2>
          <p>Keep dated expense records with vendor and payment references.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setError('');
            setShowForm(!showForm);
          }}
        >
          ＋ Record expense
        </button>
      </section>
      <section className="data-summary billing-summary">
        <div>
          <span>Recorded expenses</span>
          <b>{expenses.length}</b>
        </div>
        <div>
          <span>Approved total</span>
          <b>₹{totalExpenses.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>
        </div>
        <div>
          <span>Awaiting approval</span>
          <b>₹{pendingExpenses.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>
        </div>
      </section>
      {message && (
        <div className="success-message" role="status">
          {message}
          <button onClick={() => setMessage('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {error && !showForm && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {showForm && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            mutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Record a society expense</h3>
              <p>Enter the amount in rupees. Financial amounts are stored as integer paise.</p>
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
                Category <b>*</b>
              </span>
              <select
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value })}
              >
                {[
                  'Maintenance',
                  'Utilities',
                  'Repairs',
                  'Security',
                  'Housekeeping',
                  'Insurance',
                  'Other',
                ].map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                Description <b>*</b>
              </span>
              <input
                required
                minLength={2}
                maxLength={200}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Vendor</span>
              <input
                maxLength={160}
                value={form.vendor}
                onChange={(event) => setForm({ ...form, vendor: event.target.value })}
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
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Date <b>*</b>
              </span>
              <input
                type="date"
                required
                value={form.spentAt}
                onChange={(event) => setForm({ ...form, spentAt: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Payment reference</span>
              <input
                maxLength={100}
                value={form.reference}
                onChange={(event) => setForm({ ...form, reference: event.target.value })}
              />
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save expense'}
          </button>
        </form>
      )}
      {expenses.length === 0 ? (
        <section className="state-panel">
          <h2>No expenses recorded</h2>
          <p>Add the first expense to start a financial record.</p>
        </section>
      ) : (
        <section className="resident-table-panel">
          <div className="table-overflow">
            <table className="flat-table resident-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th>Vendor</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Bill documents</th>
                  <th>Status</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td>{new Date(expense.spentAt).toLocaleDateString()}</td>
                    <td>{expense.category}</td>
                    <td>{expense.description}</td>
                    <td>{expense.vendor || '—'}</td>
                    <td>{expense.reference || '—'}</td>
                    <td>
                      <strong>₹{expense.amount.toFixed(2)}</strong>
                    </td>
                    <td>
                      <div className="expense-documents">
                        {(expense.attachments ?? []).map((attachment) => (
                          <a
                            key={attachment.id}
                            href={`${root}/${expense.id}/attachments/${attachment.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {attachment.originalName}
                          </a>
                        ))}
                        <label className="text-button expense-upload">
                          {uploadMutation.isPending ? 'Uploading…' : '＋ Add bill document'}
                          <input
                            type="file"
                            accept="application/pdf,image/png,image/jpeg"
                            disabled={
                              uploadMutation.isPending || (expense.attachments ?? []).length >= 10
                            }
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (!file) return;
                              if (file.size > 5 * 1024 * 1024) {
                                setError('Bill documents must be 5 MB or smaller.');
                              } else {
                                setError('');
                                uploadMutation.mutate({ expense, file });
                              }
                              event.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`occupancy ${expense.status === 'APPROVED' ? 'occupied' : expense.status === 'SUBMITTED' ? 'vacant' : ''}`}
                      >
                        {expense.status.replace('_', ' ')}
                      </span>
                      {expense.rejectionReason && <small>{expense.rejectionReason}</small>}
                    </td>
                    <td>
                      {canApprove && expense.status === 'SUBMITTED' ? (
                        <div className="expense-review-actions">
                          <button
                            className="text-button"
                            disabled={reviewMutation.isPending}
                            onClick={() => reviewMutation.mutate({ expense, action: 'approve' })}
                          >
                            Approve
                          </button>
                          <input
                            aria-label={`Rejection reason for ${expense.description}`}
                            placeholder="Reason to reject"
                            maxLength={500}
                            value={reviewReasons[expense.id] ?? ''}
                            onChange={(event) =>
                              setReviewReasons({
                                ...reviewReasons,
                                [expense.id]: event.target.value,
                              })
                            }
                          />
                          <button
                            className="text-button danger"
                            disabled={
                              reviewMutation.isPending ||
                              (reviewReasons[expense.id] ?? '').trim().length < 2
                            }
                            onClick={() =>
                              reviewMutation.mutate({
                                expense,
                                action: 'reject',
                                reason: reviewReasons[expense.id].trim(),
                              })
                            }
                          >
                            Reject
                          </button>
                        </div>
                      ) : expense.reviewedAt ? (
                        <small>Reviewed {new Date(expense.reviewedAt).toLocaleDateString()}</small>
                      ) : (
                        '—'
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
