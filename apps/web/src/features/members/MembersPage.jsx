import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import QRScanner from '../../components/QRScanner.jsx';

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

export default function MembersPage({ society, csrfToken, canManage, onJoined }) {
  const root = `/societies/${society.id}/invitations`;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', role: 'RESIDENT' });
  const [inviteCode, setInviteCode] = useState('');
  const [createdInvitation, setCreatedInvitation] = useState(null);
  const [invitationQr, setInvitationQr] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    if (!createdInvitation?.code) {
      setInvitationQr('');
      return undefined;
    }
    const invitationUrl = new URL('/', window.location.origin);
    invitationUrl.hash = `invite=${encodeURIComponent(createdInvitation.code)}`;
    QRCode.toDataURL(invitationUrl.toString(), {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
    })
      .then((dataUrl) => {
        if (current) setInvitationQr(dataUrl);
      })
      .catch(() => {
        if (current) setInvitationQr('');
      });
    return () => {
      current = false;
    };
  }, [createdInvitation]);
  const query = useQuery({
    queryKey: ['members', society.id],
    queryFn: () => api(`${root}/members`),
    enabled: canManage,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members', society.id] });
  const inviteMutation = useMutation({
    mutationFn: () => api(root, { method: 'POST', csrfToken, body: form }),
    onSuccess: (result) => {
      setCreatedInvitation(result);
      setForm({ ...form, email: '' });
      setError('');
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const acceptMutation = useMutation({
    mutationFn: () =>
      api('/invitations/accept', { method: 'POST', csrfToken, body: { code: inviteCode.trim() } }),
    onSuccess: async (result) => {
      setMessage(`You joined ${result.societyName}.`);
      setInviteCode('');
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['societies'] });
      onJoined(result.membership.societyId);
    },
    onError: (cause) => setError(cause.message),
  });
  return (
    <div className="members-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">ACCESS &amp; MEMBERS</p>
          <h2>Society team</h2>
          <p>Invite residents and staff, or join a society with an invitation code.</p>
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
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <form
        className="form-card resident-form join-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          setMessage('');
          acceptMutation.mutate();
        }}
      >
        <div>
          <h3>Join a society</h3>
          <p>Scan the one-time invite QR or enter the code from a society administrator.</p>
        </div>
        <div className="join-code-row">
          <input
            aria-label="Invitation code"
            maxLength={43}
            required
            placeholder="Invitation code"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
          />
          <button className="button primary" disabled={acceptMutation.isPending}>
            {acceptMutation.isPending ? 'Joining…' : 'Join society'}
          </button>
        </div>
        <QRScanner
          label="society invitation"
          onError={setError}
          onCode={(code) => {
            setInviteCode(code);
            setError('');
            setMessage('Invitation scanned. Choose Join society to accept it.');
          }}
        />
      </form>
      {createdInvitation && (
        <section className="visitor-code-card">
          <div>
            <b>Invitation created for {createdInvitation.invitation.email}</b>
            <p>
              {createdInvitation.emailSent
                ? 'The invite email was sent. You can also share this QR or one-time code. '
                : 'The invite email could not be sent. Share this QR or one-time code directly. '}
              This invitation expires on{' '}
              {new Date(createdInvitation.invitation.expiresAt).toLocaleString()} and will not be
              shown again.
            </p>
            {createdInvitation.previewUrl && (
              <p>
                Local development invitation link:{' '}
                <a href={createdInvitation.previewUrl}>Open invite</a>
              </p>
            )}
            <code>{createdInvitation.code}</code>
            {invitationQr && (
              <>
                <img
                  className="visitor-qr"
                  src={invitationQr}
                  alt="One-time society invitation QR code"
                />
                <a
                  className="button secondary compact"
                  href={invitationQr}
                  download={`society-invitation-${createdInvitation.invitation.email}.png`}
                >
                  Download QR code
                </a>
              </>
            )}
            <button
              className="button secondary compact"
              onClick={async () => {
                await navigator.clipboard.writeText(createdInvitation.code);
              }}
            >
              Copy code
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="Dismiss invitation code"
            onClick={() => setCreatedInvitation(null)}
          >
            ×
          </button>
        </section>
      )}
      {canManage && (
        <>
          <form
            className="form-card resident-form"
            onSubmit={(event) => {
              event.preventDefault();
              setError('');
              inviteMutation.mutate();
            }}
          >
            <div className="section-heading">
              <div>
                <h3>Invite a member</h3>
                <p>Invitation codes are single-use and expire after seven days.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>
                  Email address <b>*</b>
                </span>
                <input
                  type="email"
                  required
                  maxLength={320}
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </label>
              <label className="field">
                <span>
                  Role <b>*</b>
                </span>
                <select
                  value={form.role}
                  onChange={(event) => setForm({ ...form, role: event.target.value })}
                >
                  {['RESIDENT', 'ACCOUNTANT', 'COMMITTEE_MEMBER', 'SECURITY_GUARD'].map((role) => (
                    <option key={role} value={role}>
                      {role.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className="button primary" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? 'Creating…' : 'Create invitation'}
            </button>
          </form>
          {query.isPending && (
            <section className="state-panel">
              <span className="spinner" />
              Loading society members…
            </section>
          )}
          {query.isError && (
            <section className="state-panel error-state">
              <h2>We couldn’t load members</h2>
              <p>{query.error.message}</p>
              <button className="button secondary" onClick={() => query.refetch()}>
                Try again
              </button>
            </section>
          )}
          {query.data && (
            <>
              <section className="section-heading members-subheading">
                <div>
                  <h2>Members</h2>
                  <p>
                    {query.data.members.length} account{query.data.members.length === 1 ? '' : 's'}{' '}
                    with society access.
                  </p>
                </div>
              </section>
              <section className="resident-table-panel">
                <div className="table-overflow">
                  <table className="flat-table resident-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Account</th>
                        <th>Society access</th>
                        <th>Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.members.map((membership) => (
                        <tr key={membership.id}>
                          <td>
                            <strong>{membership.user.email}</strong>
                          </td>
                          <td>{membership.role.replace('_', ' ')}</td>
                          <td>{membership.user.status}</td>
                          <td>{membership.active ? 'Active' : 'Inactive'}</td>
                          <td>{new Date(membership.createdAt).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              {query.data.invitations.length > 0 && (
                <section className="pending-invitations">
                  <h3>Pending invitations</h3>
                  {query.data.invitations.map((invitation) => (
                    <div key={invitation.id}>
                      <span>
                        <b>{invitation.email}</b>
                        <small>
                          {invitation.role.replace('_', ' ')} · expires{' '}
                          {new Date(invitation.expiresAt).toLocaleDateString()}
                        </small>
                      </span>
                      <span className="read-state">Awaiting acceptance</span>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
