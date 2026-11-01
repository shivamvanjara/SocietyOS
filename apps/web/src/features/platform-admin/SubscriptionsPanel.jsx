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

const initialPlan = {
  name: '',
  description: '',
  billingInterval: 'MONTHLY',
  price: '',
  maxBuildings: '',
  maxFlats: '',
  active: true,
};

function dateLabel(value) {
  return value ? new Date(value).toLocaleDateString() : 'No end date';
}

export default function SubscriptionsPanel({ csrfToken }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState('plans');
  const [planForm, setPlanForm] = useState(initialPlan);
  const [editingPlanId, setEditingPlanId] = useState(null);
  const [societySearch, setSocietySearch] = useState('');
  const [societyId, setSocietyId] = useState('');
  const [planId, setPlanId] = useState('');
  const [newStatus, setNewStatus] = useState('ACTIVE');
  const [endDate, setEndDate] = useState('');
  const [subscriptionSearch, setSubscriptionSearch] = useState('');
  const [subscriptionStatus, setSubscriptionStatus] = useState('ALL');
  const [cursor, setCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('success');

  const plans = useQuery({
    queryKey: ['platform-admin', 'subscription-plans'],
    queryFn: () => api('/platform-admin/subscription-plans?limit=100'),
  });
  const societyParams = new URLSearchParams({ limit: '100', status: 'ACTIVE' });
  if (societySearch.trim()) societyParams.set('search', societySearch.trim());
  const societies = useQuery({
    queryKey: ['platform-admin', 'subscription-societies', societySearch],
    queryFn: () => api(`/platform-admin/societies?${societyParams.toString()}`),
    enabled: view === 'subscriptions',
  });
  const subscriptionParams = new URLSearchParams({ limit: '50' });
  if (subscriptionSearch.trim()) subscriptionParams.set('search', subscriptionSearch.trim());
  if (subscriptionStatus !== 'ALL') subscriptionParams.set('status', subscriptionStatus);
  if (cursor) subscriptionParams.set('cursor', cursor);
  const subscriptions = useQuery({
    queryKey: ['platform-admin', 'subscriptions', subscriptionSearch, subscriptionStatus, cursor],
    queryFn: () => api(`/platform-admin/subscriptions?${subscriptionParams.toString()}`),
    enabled: view === 'subscriptions',
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['platform-admin'] });
  };
  const savePlan = useMutation({
    mutationFn: () =>
      api(
        editingPlanId
          ? `/platform-admin/subscription-plans/${editingPlanId}`
          : '/platform-admin/subscription-plans',
        {
          method: editingPlanId ? 'PATCH' : 'POST',
          csrfToken,
          body: {
            ...planForm,
            description: planForm.description.trim() || null,
            price: planForm.price.trim(),
            maxBuildings: planForm.maxBuildings ? Number(planForm.maxBuildings) : null,
            maxFlats: planForm.maxFlats ? Number(planForm.maxFlats) : null,
          },
        },
      ),
    onSuccess: async () => {
      setMessageType('success');
      setMessage(editingPlanId ? 'Plan updated.' : 'Plan created.');
      setPlanForm(initialPlan);
      setEditingPlanId(null);
      await refresh();
    },
    onError: (error) => {
      setMessageType('error');
      setMessage(error.message);
    },
  });
  const assignSubscription = useMutation({
    mutationFn: () =>
      api(`/platform-admin/societies/${societyId}/subscriptions`, {
        method: 'POST',
        csrfToken,
        body: {
          planId,
          status: newStatus,
          ...(endDate ? { endsAt: new Date(`${endDate}T23:59:59.999Z`).toISOString() } : {}),
        },
      }),
    onSuccess: async () => {
      setMessageType('success');
      setMessage('Subscription assigned to the society.');
      setEndDate('');
      await refresh();
    },
    onError: (error) => {
      setMessageType('error');
      setMessage(error.message);
    },
  });
  const updateSubscription = useMutation({
    mutationFn: ({ id, status }) =>
      api(`/platform-admin/subscriptions/${id}/status`, {
        method: 'PATCH',
        csrfToken,
        body: { status },
      }),
    onSuccess: async (_result, variables) => {
      setMessageType('success');
      setMessage(`Subscription marked ${variables.status.toLowerCase().replace('_', ' ')}.`);
      await refresh();
    },
    onError: (error) => {
      setMessageType('error');
      setMessage(error.message);
    },
  });
  const updatePlanStatus = useMutation({
    mutationFn: ({ id, active }) =>
      api(`/platform-admin/subscription-plans/${id}`, {
        method: 'PATCH',
        csrfToken,
        body: { active },
      }),
    onSuccess: async (_result, variables) => {
      setMessageType('success');
      setMessage(
        variables.active
          ? 'Plan reactivated for new subscriptions.'
          : 'Plan disabled for new subscriptions.',
      );
      await refresh();
    },
    onError: (error) => {
      setMessageType('error');
      setMessage(error.message);
    },
  });

  const editPlan = (plan) => {
    setEditingPlanId(plan.id);
    setPlanForm({
      name: plan.name,
      description: plan.description ?? '',
      billingInterval: plan.billingInterval,
      price: plan.price,
      maxBuildings: plan.maxBuildings?.toString() ?? '',
      maxFlats: plan.maxFlats?.toString() ?? '',
      active: plan.active,
    });
    setMessage('');
  };

  return (
    <div className="subscription-management">
      <nav className="platform-tabs subscription-tabs" aria-label="Subscription sections">
        <button
          className={view === 'plans' ? 'active' : ''}
          onClick={() => {
            setView('plans');
            setMessage('');
          }}
        >
          Subscription plans
        </button>
        <button
          className={view === 'subscriptions' ? 'active' : ''}
          onClick={() => {
            setView('subscriptions');
            setMessage('');
          }}
        >
          Society subscriptions
        </button>
      </nav>
      {message && (
        <p
          className={
            messageType === 'error' ? 'form-message subscription-message' : 'inline-success'
          }
          role="status"
        >
          {message}
        </p>
      )}

      {view === 'plans' ? (
        <>
          <form
            className="form-card subscription-form"
            onSubmit={(event) => {
              event.preventDefault();
              setMessage('');
              setMessageType('success');
              savePlan.mutate();
            }}
          >
            <div>
              <h3>{editingPlanId ? 'Edit plan' : 'Create a subscription plan'}</h3>
              <p>
                Set the billing interval and price used when assigning this plan. Disabling a plan
                prevents new assignments but preserves existing subscriptions. Optional building and
                flat caps are enforced when society administrators add those records.
              </p>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Plan name *</span>
                <input
                  required
                  maxLength={100}
                  value={planForm.name}
                  onChange={(event) => setPlanForm({ ...planForm, name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Billing interval *</span>
                <select
                  value={planForm.billingInterval}
                  onChange={(event) =>
                    setPlanForm({ ...planForm, billingInterval: event.target.value })
                  }
                >
                  <option value="MONTHLY">Monthly</option>
                  <option value="ANNUAL">Annual</option>
                </select>
              </label>
              <label className="field">
                <span>Price (INR) *</span>
                <input
                  required
                  inputMode="decimal"
                  pattern="(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?"
                  placeholder="0.00"
                  value={planForm.price}
                  onChange={(event) => setPlanForm({ ...planForm, price: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Description</span>
                <input
                  maxLength={1000}
                  value={planForm.description}
                  onChange={(event) =>
                    setPlanForm({ ...planForm, description: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Maximum buildings (optional)</span>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  step="1"
                  inputMode="numeric"
                  placeholder="Unlimited"
                  value={planForm.maxBuildings}
                  onChange={(event) =>
                    setPlanForm({ ...planForm, maxBuildings: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Maximum flats (optional)</span>
                <input
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  inputMode="numeric"
                  placeholder="Unlimited"
                  value={planForm.maxFlats}
                  onChange={(event) => setPlanForm({ ...planForm, maxFlats: event.target.value })}
                />
              </label>
            </div>
            <div className="form-actions">
              {editingPlanId && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setEditingPlanId(null);
                    setPlanForm(initialPlan);
                  }}
                >
                  Cancel edit
                </button>
              )}
              <button className="button primary" disabled={savePlan.isPending}>
                {savePlan.isPending ? 'Saving…' : editingPlanId ? 'Save plan' : 'Create plan'}
              </button>
            </div>
          </form>

          {plans.isPending ? (
            <section className="state-panel">
              <span className="spinner" />
              Loading plans…
            </section>
          ) : plans.isError ? (
            <section className="state-panel error-state">
              <h3>We couldn’t load plans</h3>
              <p>{plans.error.message}</p>
              <button className="button secondary" onClick={() => plans.refetch()}>
                Try again
              </button>
            </section>
          ) : plans.data.subscriptionPlans.length ? (
            <div className="table-overflow">
              <table className="flat-table platform-table">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Interval</th>
                    <th>Price</th>
                    <th>Limits</th>
                    <th>New assignments</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.data.subscriptionPlans.map((plan) => (
                    <tr key={plan.id}>
                      <td>
                        <strong>{plan.name}</strong>
                        <small>{plan.description || '—'}</small>
                      </td>
                      <td>{plan.billingInterval.toLowerCase()}</td>
                      <td>₹{plan.price}</td>
                      <td>
                        {[
                          plan.maxBuildings === null ? null : `${plan.maxBuildings} buildings`,
                          plan.maxFlats === null ? null : `${plan.maxFlats} flats`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'Unlimited'}
                      </td>
                      <td>{plan.active ? 'Available' : 'Disabled'}</td>
                      <td className="subscription-actions">
                        <button className="button secondary compact" onClick={() => editPlan(plan)}>
                          Edit
                        </button>
                        <button
                          className="button secondary compact"
                          disabled={updatePlanStatus.isPending}
                          onClick={() =>
                            updatePlanStatus.mutate({ id: plan.id, active: !plan.active })
                          }
                        >
                          {plan.active ? 'Disable' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <section className="state-panel">
              <h3>No plans created</h3>
              <p>Create a plan to assign a monthly or annual subscription to a society.</p>
            </section>
          )}
        </>
      ) : (
        <>
          <form
            className="form-card subscription-form"
            onSubmit={(event) => {
              event.preventDefault();
              setMessage('');
              setMessageType('success');
              assignSubscription.mutate();
            }}
          >
            <div>
              <h3>Assign a plan</h3>
              <p>
                Assignments and status changes are recorded in platform activity. This workflow
                records subscription terms; it does not collect recurring payments.
              </p>
            </div>
            <label className="field">
              <span>Find an active society</span>
              <input
                value={societySearch}
                maxLength={120}
                placeholder="Search society name"
                onChange={(event) => {
                  setSocietySearch(event.target.value);
                  setSocietyId('');
                }}
              />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>Society *</span>
                <select
                  required
                  value={societyId}
                  onChange={(event) => setSocietyId(event.target.value)}
                >
                  <option value="">Select a society</option>
                  {(societies.data?.societies ?? []).map((society) => (
                    <option key={society.id} value={society.id}>
                      {society.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Plan *</span>
                <select required value={planId} onChange={(event) => setPlanId(event.target.value)}>
                  <option value="">Select a plan</option>
                  {(plans.data?.subscriptionPlans ?? [])
                    .filter((plan) => plan.active)
                    .map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name} · {plan.billingInterval.toLowerCase()} · ₹{plan.price}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Starting status</span>
                <select value={newStatus} onChange={(event) => setNewStatus(event.target.value)}>
                  <option value="ACTIVE">Active</option>
                  <option value="TRIAL">Trial</option>
                </select>
              </label>
              <label className="field">
                <span>End date (optional)</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </label>
            </div>
            {societies.isPending && <p className="muted">Loading societies…</p>}
            {societies.isError && (
              <p className="form-message" role="alert">
                {societies.error.message}
              </p>
            )}
            {plans.isError && (
              <p className="form-message" role="alert">
                {plans.error.message}
              </p>
            )}
            {plans.data && !plans.data.subscriptionPlans.some((plan) => plan.active) && (
              <p className="form-message">
                Create or reactivate a plan before assigning a subscription.
              </p>
            )}
            <button
              className="button primary"
              disabled={assignSubscription.isPending || !societyId || !planId}
            >
              {assignSubscription.isPending ? 'Assigning…' : 'Assign subscription'}
            </button>
          </form>

          <div className="platform-filters subscription-list-filters">
            <label className="field">
              <span>Search societies</span>
              <input
                maxLength={120}
                value={subscriptionSearch}
                onChange={(event) => {
                  setSubscriptionSearch(event.target.value);
                  setCursor(null);
                  setCursorHistory([]);
                }}
                placeholder="Society name"
              />
            </label>
            <label className="field">
              <span>Status</span>
              <select
                value={subscriptionStatus}
                onChange={(event) => {
                  setSubscriptionStatus(event.target.value);
                  setCursor(null);
                  setCursorHistory([]);
                }}
              >
                <option value="ALL">All statuses</option>
                {['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'].map((status) => (
                  <option key={status} value={status}>
                    {status.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {subscriptions.isPending ? (
            <section className="state-panel">
              <span className="spinner" />
              Loading subscriptions…
            </section>
          ) : subscriptions.isError ? (
            <section className="state-panel error-state">
              <h3>We couldn’t load subscriptions</h3>
              <p>{subscriptions.error.message}</p>
              <button className="button secondary" onClick={() => subscriptions.refetch()}>
                Try again
              </button>
            </section>
          ) : subscriptions.data.subscriptions.length ? (
            <div className="table-overflow">
              <table className="flat-table platform-table">
                <thead>
                  <tr>
                    <th>Society</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Price</th>
                    <th>Limits</th>
                    <th>Period</th>
                    <th>Assigned by</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.data.subscriptions.map((subscription) => (
                    <tr key={subscription.id}>
                      <td>
                        <strong>{subscription.society.name}</strong>
                      </td>
                      <td>
                        {subscription.plan.name} · {subscription.billingInterval.toLowerCase()}
                      </td>
                      <td>{subscription.status.replace('_', ' ')}</td>
                      <td>₹{subscription.price}</td>
                      <td>
                        {[
                          subscription.maxBuildings === null
                            ? null
                            : `${subscription.maxBuildings} buildings`,
                          subscription.maxFlats === null ? null : `${subscription.maxFlats} flats`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'Unlimited'}
                      </td>
                      <td>
                        {dateLabel(subscription.startsAt)} – {dateLabel(subscription.endsAt)}
                      </td>
                      <td>{subscription.createdBy.email}</td>
                      <td className="subscription-actions">
                        {subscription.status === 'TRIAL' && (
                          <button
                            className="button secondary compact"
                            disabled={updateSubscription.isPending}
                            onClick={() =>
                              updateSubscription.mutate({ id: subscription.id, status: 'ACTIVE' })
                            }
                          >
                            Activate
                          </button>
                        )}
                        {['TRIAL', 'ACTIVE'].includes(subscription.status) && (
                          <button
                            className="button secondary compact"
                            disabled={updateSubscription.isPending}
                            onClick={() =>
                              updateSubscription.mutate({ id: subscription.id, status: 'PAST_DUE' })
                            }
                          >
                            Mark past due
                          </button>
                        )}
                        {subscription.status === 'PAST_DUE' && (
                          <button
                            className="button secondary compact"
                            disabled={updateSubscription.isPending}
                            onClick={() =>
                              updateSubscription.mutate({ id: subscription.id, status: 'ACTIVE' })
                            }
                          >
                            Reactivate
                          </button>
                        )}
                        {['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(subscription.status) && (
                          <button
                            className="button secondary compact"
                            disabled={updateSubscription.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Mark the subscription for ${subscription.society.name} as expired?`,
                                )
                              )
                                updateSubscription.mutate({
                                  id: subscription.id,
                                  status: 'EXPIRED',
                                });
                            }}
                          >
                            Expire
                          </button>
                        )}
                        {['ACTIVE', 'TRIAL', 'PAST_DUE'].includes(subscription.status) && (
                          <button
                            className="button secondary compact"
                            disabled={updateSubscription.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Cancel the subscription for ${subscription.society.name}?`,
                                )
                              )
                                updateSubscription.mutate({
                                  id: subscription.id,
                                  status: 'CANCELED',
                                });
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <section className="state-panel">
              <h3>No subscriptions found</h3>
              <p>Try another search, or assign a plan to an active society.</p>
            </section>
          )}
          {subscriptions.isSuccess &&
            (subscriptions.data.nextCursor || cursorHistory.length > 0) && (
              <nav className="platform-pagination" aria-label="Subscription list pages">
                <button
                  className="button secondary compact"
                  disabled={!cursorHistory.length || subscriptions.isFetching}
                  onClick={() => {
                    setCursor(cursorHistory.at(-1) ?? null);
                    setCursorHistory((history) => history.slice(0, -1));
                  }}
                >
                  Previous
                </button>
                <span>Showing page {cursorHistory.length + 1}</span>
                <button
                  className="button secondary compact"
                  disabled={!subscriptions.data.nextCursor || subscriptions.isFetching}
                  onClick={() => {
                    setCursorHistory((history) => [...history, cursor]);
                    setCursor(subscriptions.data.nextCursor);
                  }}
                >
                  Next
                </button>
              </nav>
            )}
        </>
      )}
    </div>
  );
}
