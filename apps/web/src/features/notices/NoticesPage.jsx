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

const freshForm = () => ({ title: '', body: '', category: 'General', expiresAt: '' });

export default function NoticesPage({ society, csrfToken, canPublish }) {
  const root = `/societies/${society.id}/notices`;
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(freshForm);
  const [error, setError] = useState('');
  const noticesQuery = useQuery({ queryKey: ['notices', society.id], queryFn: () => api(root) });
  const publishMutation = useMutation({
    mutationFn: () =>
      api(root, {
        method: 'POST',
        csrfToken,
        body: {
          title: form.title,
          body: form.body,
          category: form.category,
          ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
        },
      }),
    onSuccess: async () => {
      setShowForm(false);
      setForm(freshForm());
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['notices', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const readMutation = useMutation({
    mutationFn: (noticeId) =>
      api(`${root}/${noticeId}/read`, { method: 'POST', csrfToken, body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notices', society.id] }),
  });
  if (noticesQuery.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading notices…
      </section>
    );
  if (noticesQuery.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load notices</h2>
        <p>{noticesQuery.error.message}</p>
        <button className="button secondary" onClick={() => noticesQuery.refetch()}>
          Try again
        </button>
      </section>
    );
  const { notices } = noticesQuery.data;
  return (
    <div className="notices-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">COMMUNITY UPDATES</p>
          <h2>Notices</h2>
          <p>Current announcements and important information for your society.</p>
        </div>
        {canPublish && (
          <button
            className="button primary"
            onClick={() => {
              setError('');
              setShowForm(!showForm);
            }}
          >
            ＋ Publish notice
          </button>
        )}
      </section>
      {showForm && canPublish && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            publishMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Publish a notice</h3>
              <p>Published notices are visible to current society members.</p>
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
                {['General', 'Maintenance', 'Safety', 'Event', 'Urgent'].map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Expires at</span>
              <input
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
              />
            </label>
            <label className="field notice-title">
              <span>
                Title <b>*</b>
              </span>
              <input
                required
                minLength={3}
                maxLength={180}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </label>
            <label className="field notice-body">
              <span>
                Message <b>*</b>
              </span>
              <textarea
                required
                minLength={3}
                maxLength={10000}
                rows={6}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={publishMutation.isPending}>
            {publishMutation.isPending ? 'Publishing…' : 'Publish notice'}
          </button>
        </form>
      )}
      {notices.length === 0 ? (
        <section className="state-panel">
          <h2>No current notices</h2>
          <p>Published notices will appear here while they are active.</p>
        </section>
      ) : (
        <div className="notice-list">
          {notices.map((notice) => (
            <article className={`notice-card${notice.readAt ? '' : ' unread'}`} key={notice.id}>
              <div className="notice-card-top">
                <span className="society-badge">{notice.category}</span>
                <time dateTime={notice.publishedAt}>
                  {new Date(notice.publishedAt).toLocaleString()}
                </time>
              </div>
              <h3>{notice.title}</h3>
              <p className="notice-author">Posted by the society committee</p>
              <p className="notice-copy">{notice.body}</p>
              <div className="notice-card-bottom">
                {notice.expiresAt && (
                  <small>Until {new Date(notice.expiresAt).toLocaleString()}</small>
                )}
                {notice.readAt ? (
                  <span className="read-state">Read</span>
                ) : (
                  <button
                    className="button secondary compact"
                    disabled={readMutation.isPending}
                    onClick={() => readMutation.mutate(notice.id)}
                  >
                    Mark as read
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
