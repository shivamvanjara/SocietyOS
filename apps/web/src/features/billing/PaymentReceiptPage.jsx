import { useQuery } from '@tanstack/react-query';

async function loadReceipt(societyId, paymentId) {
  const response = await fetch(
    `/api/v1/societies/${encodeURIComponent(societyId)}/billing/payments/${encodeURIComponent(paymentId)}/receipt`,
    { credentials: 'include' },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || 'Could not load this receipt.');
  return payload.receipt;
}

function formatMoney(amountPaise) {
  const paise = BigInt(amountPaise);
  const rupees = paise / 100n;
  const fraction = String(paise % 100n).padStart(2, '0');
  return `₹${rupees.toLocaleString('en-IN')}.${fraction}`;
}

export default function PaymentReceiptPage() {
  const query = new URLSearchParams(window.location.search);
  const societyId = query.get('societyId') ?? '';
  const paymentId = query.get('paymentId') ?? '';
  const receiptQuery = useQuery({
    queryKey: ['payment-receipt', societyId, paymentId],
    queryFn: () => loadReceipt(societyId, paymentId),
    enabled: Boolean(societyId && paymentId),
    retry: false,
  });

  if (!societyId || !paymentId)
    return (
      <main className="receipt-page">
        <section className="receipt-card error-state">
          <h1>Receipt unavailable</h1>
          <p>This receipt link is incomplete.</p>
        </section>
      </main>
    );
  if (receiptQuery.isPending)
    return (
      <main className="receipt-page">
        <section className="receipt-card">
          <span className="spinner" />
          Loading receipt…
        </section>
      </main>
    );
  if (receiptQuery.isError)
    return (
      <main className="receipt-page">
        <section className="receipt-card error-state">
          <h1>Receipt unavailable</h1>
          <p>{receiptQuery.error.message}</p>
          <button className="button secondary" onClick={() => receiptQuery.refetch()}>
            Try again
          </button>
        </section>
      </main>
    );

  const receipt = receiptQuery.data;
  return (
    <main className="receipt-page">
      <article className="receipt-card">
        <header className="receipt-heading">
          <span className="society-badge">PAYMENT RECEIPT</span>
          <h1>{receipt.societyName}</h1>
          <p>Receipt {receipt.receiptNumber}</p>
        </header>
        <div className="receipt-amount">
          <span>Amount received</span>
          <strong>{formatMoney(receipt.amountPaise)}</strong>
        </div>
        <dl className="receipt-details">
          <div>
            <dt>Home</dt>
            <dd>{receipt.home}</dd>
          </div>
          <div>
            <dt>Charge</dt>
            <dd>{receipt.charge}</dd>
          </div>
          <div>
            <dt>Billing period</dt>
            <dd>{receipt.period}</dd>
          </div>
          <div>
            <dt>Payment method</dt>
            <dd>{receipt.method.replaceAll('_', ' ')}</dd>
          </div>
          {receipt.reference && (
            <div>
              <dt>Reference</dt>
              <dd>{receipt.reference}</dd>
            </div>
          )}
          <div>
            <dt>Received</dt>
            <dd>
              {new Date(receipt.receivedAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>Recorded</dd>
          </div>
        </dl>
        <footer className="receipt-footer">
          <p>
            Keep this receipt for your records. Contact your society office if any detail is wrong.
          </p>
          <button className="button primary receipt-print" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </footer>
      </article>
    </main>
  );
}
