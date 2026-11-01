import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import SubscriptionsPanel from './SubscriptionsPanel.jsx';

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

const tabs = [
  { id: 'societies', label: 'Societies' },
  { id: 'users', label: 'User accounts' },
  { id: 'subscriptions', label: 'Subscriptions & plans' },
  { id: 'audit-log', label: 'Platform activity' },
];

function dateLabel(value) {
  return new Date(value).toLocaleDateString();
}

export default function PlatformAdminPage({ csrfToken }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('societies');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [cursor, setCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  const [message, setMessage] = useState('');
  const overview = useQuery({
    queryKey: ['platform-admin', 'overview'],
    queryFn: () => api('/platform-admin/overview'),
  });
  const params = new URLSearchParams({ limit: '50' });
  if (search.trim() && tab !== 'audit-log') params.set('search', search.trim());
  if (status !== 'ALL' && tab !== 'audit-log') params.set('status', status);
  if (cursor && tab !== 'audit-log') params.set('cursor', cursor);
  const list = useQuery({
    queryKey: ['platform-admin', tab, search, status, cursor],
    queryFn: () => api(`/platform-admin/${tab}?${params.toString()}`),
    enabled: tab !== 'subscriptions',
  });
  const updateStatus = useMutation({
    mutationFn: ({ kind, id, nextStatus }) =>
      api(`/platform-admin/${kind}/${id}/status`, {
        method: 'PATCH',
        csrfToken,
        body: { status: nextStatus },
      }),
    onSuccess: async (_result, variables) => {
      setMessage(
        variables.nextStatus === 'SUSPENDED'
          ? `${variables.label} suspended.`
          : `${variables.label} reactivated.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['platform-admin'] }),
        queryClient.invalidateQueries({ queryKey: ['societies'] }),
      ]);
    },
    onError: (error) => setMessage(error.message),
  });

  const confirmStatusChange = ({ kind, id, currentStatus, name }) => {
    const nextStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    if (
      nextStatus === 'SUSPENDED' &&
      !window.confirm(
        kind === 'societies'
          ? `Suspend ${name}? Members will lose access to this society until it is reactivated.`
          : `Suspend ${name}? Their active sessions will be revoked.`,
      )
    )
      return;
    updateStatus.mutate({ kind, id, nextStatus, label: name });
  };

  return (
    <div className="platform-admin-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">PLATFORM OPERATIONS</p>
          <h2>Platform administration</h2>
          <p>Review SocietyOS accounts and manage society access.</p>
        </div>
      </section>
      {overview.isPending ? (
        <section className="state-panel">
          <span className="spinner" />
          Loading platform totals…
        </section>
      ) : overview.isError ? (
        <section className="state-panel error-state">
          <h2>We couldn’t load platform totals</h2>
          <p>{overview.error.message}</p>
          <button className="button secondary" onClick={() => overview.refetch()}>
            Try again
          </button>
        </section>
      ) : (
        <section className="platform-stat-grid">
          <article>
            <span>Societies</span>
            <strong>{overview.data.societies.total}</strong>
            <small>
              {overview.data.societies.active} active · {overview.data.societies.suspended}{' '}
              suspended
            </small>
          </article>
          <article>
            <span>Accounts</span>
            <strong>{overview.data.users.total}</strong>
            <small>
              {overview.data.users.active} active · {overview.data.users.suspended} suspended
            </small>
          </article>
          <article>
            <span>Flats</span>
            <strong>{overview.data.flats.total}</strong>
            <small>Registered across all societies</small>
          </article>
        </section>
      )}

      <section className="platform-admin-panel">
        <nav className="platform-tabs" aria-label="Platform administration sections">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => {
                setTab(item.id);
                setCursor(null);
                setCursorHistory([]);
                setMessage('');
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        {tab === 'subscriptions' ? (
          <SubscriptionsPanel csrfToken={csrfToken} />
        ) : (
          <>
            {tab !== 'audit-log' && (
              <div className="platform-filters">
                <label className="field">
                  <span>Search {tab === 'societies' ? 'societies' : 'email addresses'}</span>
                  <input
                    value={search}
                    maxLength={120}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setCursor(null);
                      setCursorHistory([]);
                    }}
                    placeholder={tab === 'societies' ? 'Name, city, or slug' : 'Email address'}
                  />
                </label>
                <label className="field">
                  <span>Status</span>
                  <select
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      setCursor(null);
                      setCursorHistory([]);
                    }}
                  >
                    <option value="ALL">All statuses</option>
                    <option value="ACTIVE">Active</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                </label>
              </div>
            )}
            {message && (
              <p className={updateStatus.isError ? 'form-message' : 'inline-success'} role="status">
                {message}
              </p>
            )}
            {list.isPending ? (
              <section className="state-panel">
                <span className="spinner" />
                Loading {tab === 'audit-log' ? 'platform activity' : tab}…
              </section>
            ) : list.isError ? (
              <section className="state-panel error-state">
                <h2>We couldn’t load {tab === 'audit-log' ? 'platform activity' : tab}</h2>
                <p>{list.error.message}</p>
                <button className="button secondary" onClick={() => list.refetch()}>
                  Try again
                </button>
              </section>
            ) : tab === 'societies' ? (
              list.data.societies.length ? (
                <div className="table-overflow">
                  <table className="flat-table platform-table">
                    <thead>
                      <tr>
                        <th>Society</th>
                        <th>Status</th>
                        <th>Members</th>
                        <th>Buildings</th>
                        <th>Flats</th>
                        <th>Created</th>
                        <th>Access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.societies.map((society) => (
                        <tr key={society.id}>
                          <td>
                            <strong>{society.name}</strong>
                            <small>
                              {[society.city, society.slug].filter(Boolean).join(' · ')}
                            </small>
                          </td>
                          <td>{society.status}</td>
                          <td>{society._count.memberships}</td>
                          <td>{society._count.buildings}</td>
                          <td>{society._count.flats}</td>
                          <td>{dateLabel(society.createdAt)}</td>
                          <td>
                            <button
                              className="button secondary compact"
                              disabled={updateStatus.isPending}
                              onClick={() =>
                                confirmStatusChange({
                                  kind: 'societies',
                                  id: society.id,
                                  currentStatus: society.status,
                                  name: society.name,
                                })
                              }
                            >
                              {society.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <section className="state-panel">
                  <h2>No societies found</h2>
                  <p>Try a different search or status filter.</p>
                </section>
              )
            ) : tab === 'users' ? (
              list.data.users.length ? (
                <div className="table-overflow">
                  <table className="flat-table platform-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Platform role</th>
                        <th>Status</th>
                        <th>Society memberships</th>
                        <th>Created</th>
                        <th>Access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.users.map((account) => (
                        <tr key={account.id}>
                          <td>
                            <strong>{account.email}</strong>
                          </td>
                          <td>{account.platformRole.replace('_', ' ')}</td>
                          <td>{account.status}</td>
                          <td>{account._count.memberships}</td>
                          <td>{dateLabel(account.createdAt)}</td>
                          <td>
                            <button
                              className="button secondary compact"
                              disabled={
                                updateStatus.isPending ||
                                (account.id === overview.data?.currentUserId &&
                                  account.status === 'ACTIVE')
                              }
                              onClick={() =>
                                confirmStatusChange({
                                  kind: 'users',
                                  id: account.id,
                                  currentStatus: account.status,
                                  name: account.email,
                                })
                              }
                            >
                              {account.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <section className="state-panel">
                  <h2>No accounts found</h2>
                  <p>Try a different search or status filter.</p>
                </section>
              )
            ) : list.data.entries.length ? (
              <div className="table-overflow">
                <table className="flat-table platform-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Resource</th>
                      <th>By</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.eventType.replaceAll('_', ' ')}</td>
                        <td>
                          {entry.resourceType} · {entry.resourceId.slice(0, 8)}
                        </td>
                        <td>{entry.actor.email}</td>
                        <td>{new Date(entry.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <section className="state-panel">
                <h2>No platform activity yet</h2>
                <p>Platform-wide access changes will be recorded here.</p>
              </section>
            )}
            {tab !== 'audit-log' &&
              list.isSuccess &&
              (list.data.nextCursor || cursorHistory.length > 0) && (
                <nav className="platform-pagination" aria-label="Platform list pages">
                  <button
                    className="button secondary compact"
                    disabled={!cursorHistory.length || list.isFetching}
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
                    disabled={!list.data.nextCursor || list.isFetching}
                    onClick={() => {
                      setCursorHistory((history) => [...history, cursor]);
                      setCursor(list.data.nextCursor);
                    }}
                  >
                    Next
                  </button>
                </nav>
              )}
          </>
        )}
      </section>
    </div>
  );
}
