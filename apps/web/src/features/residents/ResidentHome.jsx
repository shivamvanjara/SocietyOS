import { useMutation, useQuery } from '@tanstack/react-query';
import { PaymentInstructionsCard } from '../billing/PaymentInstructionsPanel.jsx';

let checkoutScriptPromise;

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
  if (!response.ok) throw new Error(payload.error?.message || 'Could not load your home.');
  return payload;
}

function loadCheckoutScript() {
  if (window.Razorpay) return Promise.resolve();
  checkoutScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpay = 'true';
    script.onload = resolve;
    script.onerror = () => {
      checkoutScriptPromise = undefined;
      reject(new Error('Could not load the secure payment window.'));
    };
    document.head.append(script);
  });
  return checkoutScriptPromise;
}

const money = (amount) => `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const date = (value) => new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium' });

export default function ResidentHome({ society, csrfToken, email }) {
  const root = `/societies/${society.id}`;
  const profileQuery = useQuery({
    queryKey: ['resident-home', society.id],
    queryFn: () => api(`${root}/residents/me`),
  });
  const billingQuery = useQuery({
    queryKey: ['resident-billing', society.id],
    queryFn: () => api(`${root}/billing/mine`),
  });
  const paymentInstructionsQuery = useQuery({
    queryKey: ['payment-instructions', society.id],
    queryFn: () => api(`${root}/billing/payment-instructions`),
  });
  const paymentStatusQuery = useQuery({
    queryKey: ['payment-status', society.id],
    queryFn: () => api(`/societies/${society.id}/payments/status`),
  });
  const paymentMutation = useMutation({
    mutationFn: async (invoice) => {
      const order = await api(`/societies/${society.id}/payments/orders`, {
        method: 'POST',
        body: { invoiceId: invoice.id },
        csrfToken,
      });
      const cancelOrder = () =>
        api(`/societies/${society.id}/payments/${order.orderId}/cancel`, {
          method: 'POST',
          csrfToken,
          body: {},
        }).catch(() => {});
      try {
        await loadCheckoutScript();
      } catch (error) {
        await cancelOrder();
        throw error;
      }
      await new Promise((resolve, reject) => {
        try {
          const checkout = new window.Razorpay({
            key: order.keyId,
            amount: order.amountPaise,
            currency: order.currency,
            order_id: order.orderId,
            name: 'SocietyOS',
            description: `${invoice.description} · ${invoice.period}`,
            prefill: { email },
            handler: async (result) => {
              try {
                await api(`/societies/${society.id}/payments/verify`, {
                  method: 'POST',
                  csrfToken,
                  body: {
                    orderId: result.razorpay_order_id,
                    paymentId: result.razorpay_payment_id,
                    signature: result.razorpay_signature,
                  },
                });
                resolve();
              } catch (error) {
                reject(error);
              }
            },
            modal: {
              ondismiss: async () => {
                await cancelOrder();
                reject(new Error('Payment window closed. You can try again later.'));
              },
            },
          });
          checkout.on('payment.failed', async () => {
            await cancelOrder();
            reject(new Error('Payment failed. No receipt was recorded.'));
          });
          checkout.open();
        } catch (error) {
          void cancelOrder();
          reject(error);
        }
      });
    },
    onSuccess: () => billingQuery.refetch(),
  });

  if (profileQuery.isPending || billingQuery.isPending || paymentStatusQuery.isPending) {
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading your home…
      </section>
    );
  }
  if (profileQuery.isError || billingQuery.isError || paymentStatusQuery.isError) {
    const query = profileQuery.isError
      ? profileQuery
      : billingQuery.isError
        ? billingQuery
        : paymentStatusQuery;
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load your home</h2>
        <p>{query.error.message}</p>
        <button
          className="button secondary"
          onClick={() => {
            profileQuery.refetch();
            billingQuery.refetch();
            paymentStatusQuery.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  const residents = profileQuery.data.residents;
  const invoices = billingQuery.data.invoices;
  const outstanding = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
  const pending = invoices.filter((invoice) => invoice.balance > 0).length;

  return (
    <div className="feature-page">
      <section className="welcome-banner">
        <div>
          <span className="society-badge">RESIDENT PORTAL</span>
          <h2>{residents[0]?.fullName ? `Welcome, ${residents[0].fullName}` : society.name}</h2>
          <p>{society.name} · Your home details and maintenance account</p>
        </div>
      </section>

      {residents.length ? (
        <section className="section-heading">
          <div>
            <h2>Your home</h2>
            <p>Homes linked to your SocietyOS account.</p>
          </div>
        </section>
      ) : (
        <section className="empty-panel">
          <h2>Your flat is not linked yet</h2>
          <p>Ask your society administrator to add this account email to your resident record.</p>
        </section>
      )}
      {residents.length > 0 && (
        <section className="flat-grid resident-home-flats">
          {residents.map((resident) => (
            <article className="flat-card" key={resident.id}>
              <span className="eyebrow">{resident.residentType}</span>
              <h3>
                {resident.flat.building.name} · {resident.flat.flatNumber}
              </h3>
              <p>
                Floor {resident.flat.floor}
                {resident.flat.flatType ? ` · ${resident.flat.flatType}` : ''}
              </p>
            </article>
          ))}
        </section>
      )}

      <section className="data-summary billing-summary resident-home-summary">
        <div>
          <span>Outstanding maintenance</span>
          <b>{money(outstanding)}</b>
        </div>
        <div>
          <span>Charges awaiting payment</span>
          <b>{pending}</b>
        </div>
        <div>
          <span>Recorded charges</span>
          <b>{invoices.length}</b>
        </div>
      </section>

      <section className="section-heading">
        <div>
          <h2>Maintenance history</h2>
          <p>Charges and receipts recorded by your society.</p>
        </div>
      </section>
      {invoices.length === 0 ? (
        <section className="empty-panel">
          <h2>No charges yet</h2>
          <p>New charges for your linked home will appear here.</p>
        </section>
      ) : (
        <div className="flat-table-wrap">
          <table className="flat-table">
            <thead>
              <tr>
                <th>Home</th>
                <th>Charge</th>
                <th>Bill documents</th>
                <th>Period</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Balance</th>
                <th>Status</th>
                {paymentStatusQuery.data.onlinePaymentsEnabled && <th>Payment</th>}
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    {invoice.flat.building.name} · {invoice.flat.flatNumber}
                  </td>
                  <td>
                    {invoice.description}
                    <small>Due {date(invoice.dueDate)}</small>
                  </td>
                  <td>
                    {(invoice.attachments ?? []).map((attachment) => (
                      <a
                        key={attachment.id}
                        className="resident-bill-document"
                        href={`/api/v1/societies/${society.id}/billing/${invoice.id}/attachments/${attachment.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {attachment.originalName}
                      </a>
                    ))}
                    {!invoice.attachments?.length && '—'}
                  </td>
                  <td>{invoice.period}</td>
                  <td>{money(invoice.amount)}</td>
                  <td>
                    {money(invoice.paidAmount)}
                    {invoice.payments.map((payment) => {
                      const receiptUrl = new URL('/payment-receipt', window.location.origin);
                      receiptUrl.searchParams.set('societyId', society.id);
                      receiptUrl.searchParams.set('paymentId', payment.id);
                      return (
                        <a
                          key={payment.id}
                          className="resident-receipt-link"
                          href={receiptUrl.toString()}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Receipt · {money(payment.amount)}
                        </a>
                      );
                    })}
                  </td>
                  <td>
                    <b>{money(invoice.balance)}</b>
                  </td>
                  <td>
                    <span className={`occupancy ${invoice.balance === 0 ? 'occupied' : 'vacant'}`}>
                      {invoice.balance === 0
                        ? 'Paid'
                        : invoice.paidAmount > 0
                          ? 'Partially paid'
                          : 'Outstanding'}
                    </span>
                  </td>
                  {paymentStatusQuery.data.onlinePaymentsEnabled && (
                    <td>
                      {invoice.balance > 0 && (
                        <button
                          className="button primary compact"
                          type="button"
                          disabled={paymentMutation.isPending}
                          onClick={() => paymentMutation.mutate(invoice)}
                        >
                          {paymentMutation.isPending && paymentMutation.variables?.id === invoice.id
                            ? 'Opening…'
                            : 'Pay online'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {outstanding > 0 && paymentInstructionsQuery.data?.paymentInstructions && (
        <PaymentInstructionsCard details={paymentInstructionsQuery.data.paymentInstructions} />
      )}
      {outstanding > 0 &&
        paymentInstructionsQuery.isSuccess &&
        !paymentInstructionsQuery.data.paymentInstructions && (
          <p className="muted resident-payment-note">
            This society has not added bank or UPI transfer details. Contact the society office for
            offline payment instructions.
          </p>
        )}
      {paymentInstructionsQuery.isError && (
        <p className="form-message" role="alert">
          {paymentInstructionsQuery.error.message}
        </p>
      )}
      {paymentMutation.error ? (
        <p className="form-message" role="alert">
          {paymentMutation.error.message}
        </p>
      ) : (
        <p className="muted resident-payment-note">
          {paymentStatusQuery.data.onlinePaymentsEnabled
            ? 'Pay online through Razorpay Checkout, or use the society’s bank or UPI details above. Share an offline transfer reference with your society office.'
            : 'Razorpay online checkout is not configured yet. Use the society’s bank or UPI details above and share the transfer reference with your society office.'}
        </p>
      )}
    </div>
  );
}
