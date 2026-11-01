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
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error?.message || 'Something went wrong. Please try again.');
  return payload;
}

async function fetchAll(path) {
  const complaints = [];
  let cursor;
  let canManage = false;
  let viewerUserId;
  do {
    const result = await api(`${path}?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    complaints.push(...result.complaints);
    canManage = result.canManage;
    viewerUserId = result.viewerUserId;
    cursor = result.nextCursor;
  } while (cursor);
  return { complaints, canManage, viewerUserId };
}

const emptyForm = () => ({
  category: 'Maintenance',
  title: '',
  description: '',
  priority: 'NORMAL',
});

export default function ComplaintsPage({ society, csrfToken }) {
  const root = `/societies/${society.id}/complaints`;
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [drafts, setDrafts] = useState({});
  const [replyDrafts, setReplyDrafts] = useState({});
  const [error, setError] = useState('');
  const query = useQuery({ queryKey: ['complaints', society.id], queryFn: () => fetchAll(root) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['complaints', society.id] });
  const createMutation = useMutation({
    mutationFn: () => api(root, { method: 'POST', csrfToken, body: form }),
    onSuccess: () => {
      setShowForm(false);
      setForm(emptyForm());
      setError('');
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, status }) =>
      api(`${root}/${id}`, {
        method: 'PATCH',
        csrfToken,
        body: { status, resolution: drafts[id]?.resolution || null },
      }),
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const commentMutation = useMutation({
    mutationFn: ({ id, body }) =>
      api(`${root}/${id}/comments`, { method: 'POST', csrfToken, body: { body } }),
    onSuccess: (_result, variables) => {
      setReplyDrafts({ ...replyDrafts, [variables.id]: '' });
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const attachmentMutation = useMutation({
    mutationFn: async ({ complaintId, files }) => {
      for (const file of files) {
        const response = await fetch(`${root}/${complaintId}/attachments`, {
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
          throw new Error(payload.error?.message || 'One or more images could not be uploaded.');
      }
    },
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: (cause) => {
      setError(`${cause.message} Any images already uploaded are saved.`);
      refresh();
    },
  });
  if (query.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading complaints…
      </section>
    );
  if (query.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load complaints</h2>
        <p>{query.error.message}</p>
        <button className="button secondary" onClick={() => query.refetch()}>
          Try again
        </button>
      </section>
    );
  const { complaints, canManage, viewerUserId } = query.data;
  return (
    <div className="complaints-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">COMMUNITY SUPPORT</p>
          <h2>Complaints &amp; requests</h2>
          <p>Raise an issue and follow the committee’s response.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setError('');
            setShowForm(!showForm);
          }}
        >
          ＋ New complaint
        </button>
      </section>
      {showForm && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            createMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Submit a complaint</h3>
              <p>Describe the issue so the committee can respond.</p>
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
                {['Maintenance', 'Security', 'Housekeeping', 'Noise', 'Utilities', 'Other'].map(
                  (category) => (
                    <option key={category}>{category}</option>
                  ),
                )}
              </select>
            </label>
            <label className="field">
              <span>
                Priority <b>*</b>
              </span>
              <select
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value })}
              >
                {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((priority) => (
                  <option key={priority}>{priority}</option>
                ))}
              </select>
            </label>
            <label className="field complaint-title">
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
            <label className="field complaint-description">
              <span>
                Description <b>*</b>
              </span>
              <textarea
                required
                minLength={3}
                maxLength={5000}
                rows={5}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Submitting…' : 'Submit complaint'}
          </button>
        </form>
      )}
      {error && !showForm && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {complaints.length === 0 ? (
        <section className="state-panel">
          <h2>No complaints</h2>
          <p>New submissions will appear here so you can track their progress.</p>
        </section>
      ) : (
        <div className="complaint-list">
          {complaints.map((complaint) => (
            <article className="complaint-card" key={complaint.id}>
              <div className="complaint-head">
                <div>
                  <span className="society-badge">{complaint.category}</span>
                  <span className={`complaint-priority ${complaint.priority.toLowerCase()}`}>
                    {complaint.priority}
                  </span>
                </div>
                <span className="complaint-state">{complaint.status.replace('_', ' ')}</span>
              </div>
              <h3>{complaint.title}</h3>
              <p className="complaint-description-text">{complaint.description}</p>
              <div className="complaint-meta">
                Submitted by {canManage ? complaint.submitter.email : 'you'} ·{' '}
                {new Date(complaint.createdAt).toLocaleString()}
              </div>
              <div className="complaint-attachments">
                <b>Photos ({complaint.attachments.length}/5)</b>
                {complaint.attachments.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={`${root}/${complaint.id}/attachments/${attachment.id}`}
                    download={attachment.originalName}
                  >
                    {attachment.originalName}
                  </a>
                ))}
                {complaint.attachments.length < 5 && (
                  <label className="field">
                    <span>Add photos (JPEG, PNG, or WebP; 5 MB each)</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      disabled={attachmentMutation.isPending}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = '';
                        if (files.length)
                          attachmentMutation.mutate({ complaintId: complaint.id, files });
                      }}
                    />
                  </label>
                )}
              </div>
              {complaint.resolution && (
                <div className="complaint-resolution">
                  <b>Resolution</b>
                  <p>{complaint.resolution}</p>
                </div>
              )}
              {canManage && (
                <div className="complaint-status-form">
                  <label className="field">
                    <span>Status</span>
                    <select
                      value={drafts[complaint.id]?.status ?? complaint.status}
                      onChange={(event) =>
                        setDrafts({
                          ...drafts,
                          [complaint.id]: { ...drafts[complaint.id], status: event.target.value },
                        })
                      }
                    >
                      {['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Resolution note</span>
                    <input
                      maxLength={2000}
                      value={drafts[complaint.id]?.resolution ?? complaint.resolution ?? ''}
                      onChange={(event) =>
                        setDrafts({
                          ...drafts,
                          [complaint.id]: {
                            ...drafts[complaint.id],
                            resolution: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <button
                    className="button secondary compact"
                    disabled={
                      updateMutation.isPending ||
                      ((drafts[complaint.id]?.status ?? complaint.status) === complaint.status &&
                        (drafts[complaint.id]?.resolution ?? complaint.resolution ?? null) ===
                          (complaint.resolution ?? null))
                    }
                    onClick={() =>
                      updateMutation.mutate({
                        id: complaint.id,
                        status: drafts[complaint.id]?.status ?? complaint.status,
                      })
                    }
                  >
                    Update status
                  </button>
                </div>
              )}
              {complaint.comments.length > 0 && (
                <div className="complaint-comments">
                  <b>Discussion</b>
                  {complaint.comments.map((comment) => (
                    <p key={comment.id}>
                      <span>
                        {comment.authorId === viewerUserId
                          ? 'You'
                          : canManage
                            ? 'Society member'
                            : 'Society team'}
                      </span>
                      {comment.body}
                      <small>{new Date(comment.createdAt).toLocaleString()}</small>
                    </p>
                  ))}
                </div>
              )}
              <form
                className="complaint-reply"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = replyDrafts[complaint.id]?.trim();
                  if (body) commentMutation.mutate({ id: complaint.id, body });
                }}
              >
                <input
                  aria-label="Reply to complaint"
                  maxLength={3000}
                  placeholder="Write a reply…"
                  value={replyDrafts[complaint.id] ?? ''}
                  onChange={(event) =>
                    setReplyDrafts({ ...replyDrafts, [complaint.id]: event.target.value })
                  }
                />
                <button
                  className="button secondary compact"
                  disabled={commentMutation.isPending || !replyDrafts[complaint.id]?.trim()}
                >
                  Reply
                </button>
              </form>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
