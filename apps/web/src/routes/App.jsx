import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import BuildingsPage from '../features/buildings/BuildingsPage.jsx';
import ResidentsPage from '../features/residents/ResidentsPage.jsx';
import ResidentHome from '../features/residents/ResidentHome.jsx';
import BillingPage from '../features/billing/BillingPage.jsx';
import PaymentReceiptPage from '../features/billing/PaymentReceiptPage.jsx';
import ExpensesPage from '../features/expenses/ExpensesPage.jsx';
import NoticesPage from '../features/notices/NoticesPage.jsx';
import ComplaintsPage from '../features/complaints/ComplaintsPage.jsx';
import FacilitiesPage from '../features/facilities/FacilitiesPage.jsx';
import VisitorsPage from '../features/visitors/VisitorsPage.jsx';
import MembersPage from '../features/members/MembersPage.jsx';
import SubscriptionPage from '../features/subscriptions/SubscriptionPage.jsx';
import MfaSettings from '../features/security/MfaSettings.jsx';
import PlatformAdminPage from '../features/platform-admin/PlatformAdminPage.jsx';
import QRScanner from '../components/QRScanner.jsx';

const API = '/api/v1';

async function api(path, { method = 'GET', body, csrfToken } = {}) {
  const response = await fetch(`${API}${path}`, {
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
  if (!response.ok) {
    const error = new Error(payload.error?.message || 'Something went wrong. Please try again.');
    error.status = response.status;
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

function Field({ label, name, value, onChange, required = false, maxLength }) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b aria-hidden="true"> *</b>}
      </span>
      <input
        name={name}
        value={value ?? ''}
        onChange={onChange}
        required={required}
        maxLength={maxLength}
        autoComplete="off"
      />
    </label>
  );
}

function Login({ onLogin }) {
  const invitationCode = new URLSearchParams(window.location.hash.slice(1)).get('invite') ?? '';
  const [mode, setMode] = useState(invitationCode ? 'register' : 'login');
  const [joinInvite, setJoinInvite] = useState(Boolean(invitationCode));
  const [form, setForm] = useState({
    email: '',
    password: '',
    societyName: '',
    city: '',
    inviteCode: invitationCode,
  });
  const [message, setMessage] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [messageCode, setMessageCode] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const recoveryMode = mode === 'forgot' || mode === 'verify';
  useEffect(() => {
    if (invitationCode)
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [invitationCode]);
  const submitLabel =
    mode === 'forgot'
      ? 'Send reset link'
      : mode === 'verify'
        ? 'Send verification link'
        : mode === 'login'
          ? 'Sign in'
          : joinInvite
            ? 'Create account & join'
            : 'Create account';
  const pendingLabel = recoveryMode
    ? 'Preparing link…'
    : mode === 'login'
      ? 'Signing in…'
      : 'Creating workspace…';
  const mutation = useMutation({
    mutationFn: () => {
      if (recoveryMode)
        return api(
          mode === 'forgot' ? '/auth/password-reset/request' : '/auth/email-verification/request',
          {
            method: 'POST',
            body: { email: form.email },
          },
        );
      const body =
        mode === 'register'
          ? joinInvite
            ? { email: form.email, password: form.password, inviteCode: form.inviteCode.trim() }
            : {
                email: form.email,
                password: form.password,
                societyName: form.societyName,
                ...(form.city ? { city: form.city } : {}),
              }
          : { email: form.email, password: form.password };
      return api(`/auth/${mode}`, { method: 'POST', body });
    },
    onSuccess: (result) => {
      if (recoveryMode) {
        setMessage(result.message);
        setPreviewUrl(result.previewUrl ?? '');
      } else if (result.requiresMfa) {
        setForm((current) => ({ ...current, password: '' }));
        setMessage(result.message);
        setMode('mfa');
      } else if (result.requiresEmailVerification) {
        setMode('login');
        setMessage(result.message);
        setPreviewUrl(result.previewUrl ?? '');
      } else onLogin(result);
    },
    onError: (error) => {
      setMessage(error.message);
      setMessageCode(error.code ?? '');
    },
  });
  const mfaMutation = useMutation({
    mutationFn: () => api('/auth/mfa/verify', { method: 'POST', body: { code: mfaCode } }),
    onSuccess: onLogin,
    onError: (error) => {
      setMessage(error.message);
      setMessageCode(error.code ?? '');
    },
  });

  return (
    <main className="auth-layout">
      <section className="auth-brand">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>SocietyOS</span>
        </div>
        <div className="brand-copy">
          <p className="eyebrow">COMMUNITY OPERATIONS</p>
          <h1>
            Your community,
            <br />
            in good order.
          </h1>
          <p>One calm workspace for the people and places that make a residential community run.</p>
        </div>
        <span className="brand-foot">Residential management, thoughtfully organized.</span>
      </section>
      <section className="auth-panel">
        <form
          className="form-card login-card"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage('');
            setMessageCode('');
            if (mode === 'mfa') mfaMutation.mutate();
            else mutation.mutate();
          }}
        >
          <p className="eyebrow">
            {mode === 'login' || mode === 'mfa'
              ? 'WELCOME BACK'
              : recoveryMode
                ? 'ACCOUNT RECOVERY'
                : 'GET STARTED'}
          </p>
          <h2>
            {mode === 'login'
              ? 'Sign in to your workspace'
              : mode === 'mfa'
                ? 'Verify your sign-in'
                : mode === 'forgot'
                  ? 'Reset your password'
                  : mode === 'verify'
                    ? 'Verify your email'
                    : joinInvite
                      ? 'Join your society workspace'
                      : 'Create your society workspace'}
          </h2>
          <p className="muted">
            {mode === 'login'
              ? 'Use your SocietyOS account to continue.'
              : mode === 'mfa'
                ? 'Enter the six-digit code from your authenticator app to finish signing in.'
                : mode === 'forgot'
                  ? 'We’ll send a one-time reset link if an active account matches that email.'
                  : mode === 'verify'
                    ? 'Request a fresh verification link for your SocietyOS account.'
                    : joinInvite
                      ? 'Use the invitation code shared by your society administrator.'
                      : 'Your account will be the first administrator for your society.'}
          </p>
          {mode === 'register' && joinInvite && (
            <>
              <Field
                label="Invitation code"
                name="inviteCode"
                value={form.inviteCode}
                required
                maxLength={43}
                onChange={(event) => setForm({ ...form, inviteCode: event.target.value })}
              />
              <QRScanner
                label="society invitation"
                onError={setMessage}
                onCode={(code) => {
                  setForm({ ...form, inviteCode: code });
                  setMessage('Invitation scanned. Complete the form to join this society.');
                }}
              />
            </>
          )}
          {mode === 'register' && !joinInvite && (
            <>
              <Field
                label="Society name"
                name="societyName"
                value={form.societyName}
                required
                maxLength={160}
                onChange={(event) => setForm({ ...form, societyName: event.target.value })}
              />
              <Field
                label="City (optional)"
                name="city"
                value={form.city}
                maxLength={100}
                onChange={(event) => setForm({ ...form, city: event.target.value })}
              />
            </>
          )}
          {mode !== 'mfa' ? (
            <Field
              label="Email address"
              name="email"
              value={form.email}
              required
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          ) : (
            <p className="muted">Account: {form.email}</p>
          )}
          {mode === 'mfa' && (
            <label className="field">
              <span>Authenticator code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
              />
            </label>
          )}
          {!recoveryMode && mode !== 'mfa' && (
            <label className="field">
              <span>
                Password<b aria-hidden="true"> *</b>
              </span>
              <input
                type="password"
                name="password"
                value={form.password}
                required
                minLength={mode === 'register' ? 12 : 1}
                maxLength={128}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </label>
          )}
          {message && (
            <p className="form-message" role={messageCode ? 'alert' : 'status'}>
              {message}
            </p>
          )}
          {previewUrl && (
            <p className="setup-note">
              Local development link:{' '}
              <a href={previewUrl}>
                {previewUrl.includes('/verify-email') ? 'Verify email address' : 'Reset password'}
              </a>
            </p>
          )}
          {messageCode === 'EMAIL_NOT_VERIFIED' && (
            <p className="auth-switch">
              <button
                type="button"
                onClick={() => {
                  setMessage('');
                  setMessageCode('');
                  setPreviewUrl('');
                  setMode('verify');
                }}
              >
                Resend verification email
              </button>
            </p>
          )}
          <button
            className="button primary full"
            type="submit"
            disabled={
              mode === 'mfa' ? mfaMutation.isPending || mfaCode.length !== 6 : mutation.isPending
            }
          >
            {mode === 'mfa'
              ? mfaMutation.isPending
                ? 'Verifying…'
                : 'Verify code'
              : mutation.isPending
                ? pendingLabel
                : submitLabel}{' '}
            <span aria-hidden="true">→</span>
          </button>
          {mode === 'mfa' && (
            <p className="auth-switch">
              <button
                type="button"
                onClick={() => {
                  setMfaCode('');
                  setMessage('');
                  setMode('login');
                }}
              >
                Back to sign in
              </button>
            </p>
          )}
          {mode === 'register' && (
            <p className="auth-switch">
              {joinInvite ? 'Setting up a new society?' : 'Joining an existing society?'}{' '}
              <button
                type="button"
                onClick={() => {
                  setMessage('');
                  setJoinInvite(!joinInvite);
                }}
              >
                {joinInvite ? 'Create a society' : 'Enter an invitation code'}
              </button>
            </p>
          )}
          {mode === 'login' && (
            <p className="auth-switch">
              <button
                type="button"
                onClick={() => {
                  setMessage('');
                  setPreviewUrl('');
                  setMode('forgot');
                }}
              >
                Forgot password?
              </button>
              {' · '}
              <button
                type="button"
                onClick={() => {
                  setMessage('');
                  setMessageCode('');
                  setPreviewUrl('');
                  setMode('verify');
                }}
              >
                Resend verification
              </button>
            </p>
          )}
          {mode !== 'mfa' && (
            <p className="auth-switch">
              {mode === 'login'
                ? 'New to SocietyOS?'
                : mode === 'register'
                  ? 'Already have an account?'
                  : 'Return to sign in'}{' '}
              <button
                type="button"
                onClick={() => {
                  setMessage('');
                  setMessageCode('');
                  setPreviewUrl('');
                  setMode(mode === 'login' ? 'register' : 'login');
                }}
              >
                {mode === 'login' ? 'Create an account' : 'Sign in'}
              </button>
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

function PasswordResetPage() {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const mutation = useMutation({
    mutationFn: () =>
      api('/auth/password-reset/confirm', { method: 'POST', body: { token, password } }),
    onSuccess: (result) => setMessage(result.message),
    onError: (error) => setMessage(error.message),
  });

  return (
    <main className="auth-layout">
      <section className="auth-brand">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>SocietyOS</span>
        </div>
        <div className="brand-copy">
          <p className="eyebrow">ACCOUNT RECOVERY</p>
          <h1>
            Secure access,
            <br />
            restored.
          </h1>
        </div>
        <span className="brand-foot">Residential management, thoughtfully organized.</span>
      </section>
      <section className="auth-panel">
        <form
          className="form-card login-card"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage('');
            mutation.mutate();
          }}
        >
          <p className="eyebrow">NEW PASSWORD</p>
          <h2>Choose a new password</h2>
          <p className="muted">
            Use at least 12 characters. Reset links expire after 30 minutes and work once.
          </p>
          <label className="field">
            <span>
              Password<b aria-hidden="true"> *</b>
            </span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
          <button className="button primary full" disabled={mutation.isPending || !token}>
            {mutation.isPending ? 'Updating…' : 'Update password'} <span aria-hidden="true">→</span>
          </button>
          {!token && (
            <p className="form-message" role="alert">
              This reset link is missing. Request a new link from sign in.
            </p>
          )}
          <p className="auth-switch">
            <a href="/">Back to sign in</a>
          </p>
        </form>
      </section>
    </main>
  );
}

function EmailVerificationPage({ onVerified }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const started = useRef(false);
  const mutation = useMutation({
    mutationFn: () => api('/auth/email-verification/confirm', { method: 'POST', body: { token } }),
    onSuccess: (session) => {
      window.history.replaceState(null, '', '/');
      onVerified(session);
    },
  });
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      mutation.mutate();
    }
  }, [token, mutation.mutate]);

  return (
    <main className="auth-layout">
      <section className="auth-brand">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>SocietyOS</span>
        </div>
        <div className="brand-copy">
          <p className="eyebrow">ACCOUNT VERIFICATION</p>
          <h1>
            One last step,
            <br />
            then you’re in.
          </h1>
        </div>
        <span className="brand-foot">Residential management, thoughtfully organized.</span>
      </section>
      <section className="auth-panel">
        <section className="form-card login-card">
          <p className="eyebrow">VERIFY EMAIL</p>
          <h2>
            {mutation.isPending
              ? 'Verifying your address…'
              : mutation.isSuccess
                ? 'Email verified'
                : 'Confirm your email address'}
          </h2>
          {mutation.isPending && <p className="muted">This should only take a moment.</p>}
          {mutation.isError && (
            <p className="form-message" role="alert">
              {mutation.error.message}
            </p>
          )}
          {!token && (
            <p className="form-message" role="alert">
              This verification link is missing. Request another from sign in.
            </p>
          )}
          {!mutation.isPending && !mutation.isSuccess && (
            <p className="auth-switch">
              <a href="/">Back to sign in</a>
            </p>
          )}
        </section>
      </section>
    </main>
  );
}

function SocietyForm({ initial = {}, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    name: initial.name ?? '',
    addressLine1: initial.addressLine1 ?? '',
    addressLine2: initial.addressLine2 ?? '',
    city: initial.city ?? '',
    state: initial.state ?? '',
    postalCode: initial.postalCode ?? '',
    registrationCode: initial.registrationCode ?? '',
  });
  const change = (event) => setForm({ ...form, [event.target.name]: event.target.value });
  return (
    <form
      className="form-card society-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <div>
        <p className="eyebrow">SOCIETY DETAILS</p>
        <h2>{initial.name ? 'Edit society profile' : 'Set up your society'}</h2>
        <p className="muted">
          Start with the basics. You can add buildings and flats in a later step.
        </p>
      </div>
      <div className="form-grid">
        <Field
          label="Society name"
          name="name"
          value={form.name}
          onChange={change}
          required
          maxLength={160}
        />
        <Field
          label="Registration code"
          name="registrationCode"
          value={form.registrationCode}
          onChange={change}
          maxLength={80}
        />
        <Field
          label="Address line 1"
          name="addressLine1"
          value={form.addressLine1}
          onChange={change}
          maxLength={200}
        />
        <Field
          label="Address line 2"
          name="addressLine2"
          value={form.addressLine2}
          onChange={change}
          maxLength={200}
        />
        <Field label="City" name="city" value={form.city} onChange={change} maxLength={100} />
        <Field label="State" name="state" value={form.state} onChange={change} maxLength={100} />
        <Field
          label="PIN code"
          name="postalCode"
          value={form.postalCode}
          onChange={change}
          maxLength={6}
        />
      </div>
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {onCancel && (
          <button className="button secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="button primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : initial.name ? 'Save profile' : 'Create society'}
        </button>
      </div>
    </form>
  );
}

function Workspace({ user, csrfToken, onLogout }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [activePage, setActivePage] = useState(
    user.platformRole === 'SUPER_ADMIN' ? 'platform' : 'overview',
  );
  const [selectedSocietyId, setSelectedSocietyId] = useState(null);
  const [notice, setNotice] = useState('');
  const societiesQuery = useQuery({
    queryKey: ['societies'],
    queryFn: () => api('/societies'),
    enabled: user.platformRole !== 'SUPER_ADMIN' || activePage !== 'platform',
  });
  const societies = societiesQuery.data?.societies ?? [];
  const selected = societies.find((society) => society.id === selectedSocietyId) ?? societies[0];
  useEffect(() => {
    if (selected?.role === 'SECURITY_GUARD') setActivePage('visitors');
  }, [selected?.id, selected?.role]);
  const isSocietyAdmin = selected?.role === 'SOCIETY_ADMIN';
  const isAccountant = ['SOCIETY_ADMIN', 'ACCOUNTANT'].includes(selected?.role);
  const isResident = selected?.role === 'RESIDENT';
  const createMutation = useMutation({
    mutationFn: (body) => api('/societies', { method: 'POST', body, csrfToken }),
    onSuccess: async () => {
      setNotice('Your society workspace is ready.');
      await queryClient.invalidateQueries({ queryKey: ['societies'] });
    },
  });
  const updateMutation = useMutation({
    mutationFn: (body) => api(`/societies/${selected.id}`, { method: 'PATCH', body, csrfToken }),
    onSuccess: async () => {
      setEditing(false);
      setNotice('Society profile saved.');
      await queryClient.invalidateQueries({ queryKey: ['societies'] });
    },
  });
  const mutationError = createMutation.error || updateMutation.error;

  return (
    <div className={`app-shell${selected?.role === 'SECURITY_GUARD' ? ' guard-mode' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>SocietyOS</span>
        </div>
        <div className="side-label">
          {selected?.role === 'SECURITY_GUARD' ? 'GATE DESK' : 'WORKSPACE'}
        </div>
        <nav className="side-nav" aria-label="Workspace">
          {user.platformRole === 'SUPER_ADMIN' && (
            <button
              className={`side-item${activePage === 'platform' ? ' active' : ''}`}
              onClick={() => {
                setEditing(false);
                setActivePage('platform');
              }}
            >
              <span className="side-icon" aria-hidden="true">
                ◉
              </span>{' '}
              Platform administration
            </button>
          )}
          <button
            className={`side-item${activePage === 'overview' ? ' active' : ''}`}
            onClick={() => {
              setEditing(false);
              setActivePage('overview');
            }}
          >
            <span className="side-icon" aria-hidden="true">
              ⌂
            </span>{' '}
            {isResident ? 'My home' : 'Society overview'}
          </button>
          {isSocietyAdmin && (
            <>
              <button
                className={`side-item${activePage === 'subscription' ? ' active' : ''}`}
                onClick={() => {
                  setEditing(false);
                  setActivePage('subscription');
                }}
              >
                <span className="side-icon" aria-hidden="true">
                  ◷
                </span>{' '}
                Subscription
              </button>
              <button
                className={`side-item${activePage === 'buildings' ? ' active' : ''}`}
                onClick={() => {
                  setEditing(false);
                  setActivePage('buildings');
                }}
              >
                <span className="side-icon" aria-hidden="true">
                  ▦
                </span>{' '}
                Buildings &amp; flats
              </button>
              <button
                className={`side-item${activePage === 'residents' ? ' active' : ''}`}
                onClick={() => {
                  setEditing(false);
                  setActivePage('residents');
                }}
              >
                <span className="side-icon" aria-hidden="true">
                  ◎
                </span>{' '}
                Residents
              </button>
            </>
          )}
          <button
            className={`side-item${activePage === 'security' ? ' active' : ''}`}
            onClick={() => {
              setEditing(false);
              setActivePage('security');
            }}
          >
            <span className="side-icon" aria-hidden="true">
              ◈
            </span>{' '}
            Security &amp; MFA
          </button>
          {isAccountant && (
            <>
              <button
                className={`side-item${activePage === 'billing' ? ' active' : ''}`}
                onClick={() => {
                  setEditing(false);
                  setActivePage('billing');
                }}
              >
                <span className="side-icon" aria-hidden="true">
                  ₹
                </span>{' '}
                Billing
              </button>
              <button
                className={`side-item${activePage === 'expenses' ? ' active' : ''}`}
                onClick={() => {
                  setEditing(false);
                  setActivePage('expenses');
                }}
              >
                <span className="side-icon" aria-hidden="true">
                  ↗
                </span>{' '}
                Expenses
              </button>
            </>
          )}
          <button
            className={`side-item${activePage === 'notices' ? ' active' : ''}`}
            onClick={() => {
              setEditing(false);
              setActivePage('notices');
            }}
          >
            <span className="side-icon" aria-hidden="true">
              ▤
            </span>{' '}
            Notices
          </button>
          <button
            className={`side-item${activePage === 'complaints' ? ' active' : ''}`}
            onClick={() => {
              setEditing(false);
              setActivePage('complaints');
            }}
          >
            <span className="side-icon" aria-hidden="true">
              !
            </span>{' '}
            Complaints
          </button>
          <button
            className={`side-item${activePage === 'facilities' ? ' active' : ''}`}
            onClick={() => {
              setEditing(false);
              setActivePage('facilities');
            }}
          >
            <span className="side-icon" aria-hidden="true">
              ⌂
            </span>{' '}
            Facilities
          </button>
          <button
            className={`side-item${activePage === 'visitors' ? ' active' : ''}${selected?.role === 'SECURITY_GUARD' ? ' guard-nav-item' : ''}`}
            onClick={() => {
              setEditing(false);
              setActivePage('visitors');
            }}
          >
            <span className="side-icon" aria-hidden="true">
              ↔
            </span>{' '}
            Visitors
          </button>
          {isSocietyAdmin && (
            <button
              className={`side-item${activePage === 'members' ? ' active' : ''}`}
              onClick={() => {
                setEditing(false);
                setActivePage('members');
              }}
            >
              <span className="side-icon" aria-hidden="true">
                ♙
              </span>{' '}
              Members &amp; access
            </button>
          )}
        </nav>
        <div className="side-bottom">
          <span className="avatar">{user.email.slice(0, 1).toUpperCase()}</span>
          <span className="account">
            <b>{user.email}</b>
            <small>Platform account</small>
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={onLogout}
            aria-label="Sign out"
            title="Sign out"
          >
            ↗
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="page-header">
          <div>
            {societies.length > 1 && activePage !== 'platform' ? (
              <label className="society-switcher">
                <span className="sr-only">Active society</span>
                <select
                  value={selected?.id ?? ''}
                  onChange={(event) => {
                    setSelectedSocietyId(event.target.value);
                    setActivePage('overview');
                    setEditing(false);
                  }}
                >
                  {societies.map((society) => (
                    <option key={society.id} value={society.id}>
                      {society.name} · {society.role.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
            ) : activePage === 'platform' ? (
              <p className="eyebrow">PLATFORM OPERATIONS</p>
            ) : (
              <p className="eyebrow">{selected?.name ?? 'SOCIETY MANAGEMENT'}</p>
            )}
            <h1>
              {activePage === 'overview'
                ? isResident
                  ? 'My home'
                  : 'Society overview'
                : activePage === 'platform'
                  ? 'Platform administration'
                  : activePage === 'subscription'
                    ? 'Subscription & billing'
                    : activePage === 'buildings'
                      ? 'Buildings & flats'
                      : activePage === 'residents'
                        ? 'Residents'
                        : activePage === 'billing'
                          ? 'Billing'
                          : activePage === 'expenses'
                            ? 'Expenses'
                            : activePage === 'notices'
                              ? 'Notices'
                              : activePage === 'complaints'
                                ? 'Complaints'
                                : activePage === 'facilities'
                                  ? 'Facilities'
                                  : activePage === 'visitors'
                                    ? 'Visitors'
                                    : activePage === 'security'
                                      ? 'Security & MFA'
                                      : 'Members & access'}
            </h1>
          </div>
          <span className="secure-label">
            <span /> Secure workspace
          </span>
        </header>
        {notice && (
          <div className="success-message" role="status">
            {notice}
            <button onClick={() => setNotice('')} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {activePage !== 'platform' && societiesQuery.isPending && (
          <section className="state-panel">
            <span className="spinner" />
            Loading your societies…
          </section>
        )}
        {activePage !== 'platform' && societiesQuery.isError && (
          <section className="state-panel error-state">
            <h2>We couldn’t load your workspace</h2>
            <p>{societiesQuery.error.message}</p>
            <button className="button secondary" onClick={() => societiesQuery.refetch()}>
              Try again
            </button>
          </section>
        )}
        {societiesQuery.data && !selected && activePage === 'overview' && (
          <SocietyForm
            onSave={(body) => createMutation.mutate(body)}
            saving={createMutation.isPending}
            error={mutationError?.message}
          />
        )}
        {selected && activePage === 'overview' && editing && (
          <SocietyForm
            key={selected.id}
            initial={selected}
            onSave={(body) => updateMutation.mutate(body)}
            onCancel={() => setEditing(false)}
            saving={updateMutation.isPending}
            error={mutationError?.message}
          />
        )}
        {selected && activePage === 'overview' && isResident && (
          <ResidentHome society={selected} csrfToken={csrfToken} email={user.email} />
        )}
        {selected && activePage === 'buildings' && (
          <BuildingsPage
            society={selected}
            csrfToken={csrfToken}
            canManage={selected.role === 'SOCIETY_ADMIN'}
          />
        )}
        {selected && activePage === 'subscription' && isSocietyAdmin && (
          <SubscriptionPage society={selected} csrfToken={csrfToken} />
        )}
        {selected && activePage === 'residents' && (
          <ResidentsPage
            society={selected}
            csrfToken={csrfToken}
            canManage={selected.role === 'SOCIETY_ADMIN'}
          />
        )}
        {selected && activePage === 'billing' && (
          <BillingPage
            society={selected}
            csrfToken={csrfToken}
            canManage={['SOCIETY_ADMIN', 'ACCOUNTANT'].includes(selected.role)}
            canConfigurePaymentDetails={selected.role === 'SOCIETY_ADMIN'}
          />
        )}
        {selected && activePage === 'expenses' && (
          <ExpensesPage
            society={selected}
            csrfToken={csrfToken}
            canManage={['SOCIETY_ADMIN', 'ACCOUNTANT'].includes(selected.role)}
            canApprove={selected.role === 'SOCIETY_ADMIN'}
          />
        )}
        {selected && activePage === 'notices' && (
          <NoticesPage
            society={selected}
            csrfToken={csrfToken}
            canPublish={['SOCIETY_ADMIN', 'COMMITTEE_MEMBER'].includes(selected.role)}
          />
        )}
        {selected && activePage === 'complaints' && (
          <ComplaintsPage society={selected} csrfToken={csrfToken} />
        )}
        {selected && activePage === 'facilities' && (
          <FacilitiesPage
            society={selected}
            csrfToken={csrfToken}
            canManage={['SOCIETY_ADMIN', 'COMMITTEE_MEMBER'].includes(selected.role)}
          />
        )}
        {selected && activePage === 'visitors' && (
          <VisitorsPage society={selected} csrfToken={csrfToken} role={selected.role} />
        )}
        {selected && activePage === 'members' && (
          <MembersPage
            society={selected}
            csrfToken={csrfToken}
            canManage={selected.role === 'SOCIETY_ADMIN'}
            onJoined={(societyId) => {
              setSelectedSocietyId(societyId);
              setActivePage('overview');
            }}
          />
        )}
        {activePage === 'security' && <MfaSettings csrfToken={csrfToken} />}
        {activePage === 'platform' && user.platformRole === 'SUPER_ADMIN' && (
          <PlatformAdminPage csrfToken={csrfToken} />
        )}
        {selected && activePage === 'overview' && !editing && isSocietyAdmin && (
          <>
            <section className="welcome-banner">
              <div>
                <span className="society-badge">ACTIVE SOCIETY</span>
                <h2>{selected.name}</h2>
                <p>
                  {[selected.addressLine1, selected.city, selected.state, selected.postalCode]
                    .filter(Boolean)
                    .join(', ') || 'Add your address to complete your society profile.'}
                </p>
              </div>
              <button className="button white" onClick={() => setEditing(true)}>
                Edit profile
              </button>
            </section>
            <section className="section-heading">
              <div>
                <h2>Workspace setup</h2>
                <p>Complete the basics before adding your community data.</p>
              </div>
            </section>
            <section className="setup-list">
              <div className="setup-row">
                <span className="step-number done">✓</span>
                <span>
                  <b>Society profile</b>
                  <small>Name and registration details</small>
                </span>
                <span className="step-state">Complete</span>
              </div>
              <div className="setup-row">
                <span className="step-number">2</span>
                <span>
                  <b>Buildings and flats</b>
                  <small>Organize your community layout</small>
                </span>
                <span className="step-state upcoming">Next milestone</span>
                <button
                  className="button secondary compact"
                  onClick={() => setActivePage('buildings')}
                >
                  Open
                </button>
              </div>
              <div className="setup-row">
                <span className="step-number">3</span>
                <span>
                  <b>Invite administrators</b>
                  <small>Give your team the right access</small>
                </span>
                <span className="step-state upcoming">Coming soon</span>
              </div>
            </section>
          </>
        )}
        {selected && activePage === 'overview' && !isResident && !isSocietyAdmin && (
          <section className="empty-panel role-home-panel">
            <span className="society-badge">{selected.role.replaceAll('_', ' ')}</span>
            <h2>{selected.name}</h2>
            <p>Your workspace shows only the tools available to your society role.</p>
            <button
              className="button primary"
              onClick={() =>
                setActivePage(selected.role === 'SECURITY_GUARD' ? 'visitors' : 'complaints')
              }
            >
              {selected.role === 'SECURITY_GUARD' ? 'Open visitor desk' : 'Open complaints'}
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const isPasswordReset = window.location.pathname === '/reset-password';
  const isEmailVerification = window.location.pathname === '/verify-email';
  const isPaymentReceipt = window.location.pathname === '/payment-receipt';
  const authQuery = useQuery({
    queryKey: ['auth'],
    queryFn: async () => {
      try {
        return await api('/auth/me');
      } catch (error) {
        if (error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    enabled: !isPasswordReset && !isEmailVerification && !isPaymentReceipt,
  });
  const login = (session) => queryClient.setQueryData(['auth'], session);
  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', csrfToken: authQuery.data?.csrfToken });
    } finally {
      queryClient.setQueryData(['auth'], null);
      queryClient.removeQueries({ queryKey: ['societies'] });
    }
  };

  if (isPasswordReset) return <PasswordResetPage />;
  if (isEmailVerification) return <EmailVerificationPage onVerified={login} />;
  if (isPaymentReceipt) return <PaymentReceiptPage />;
  if (authQuery.isPending)
    return (
      <main className="loading-screen">
        <span className="spinner" />
        Loading SocietyOS…
      </main>
    );
  if (authQuery.isError)
    return (
      <main className="loading-screen error-state">
        <h1>Service temporarily unavailable</h1>
        <p>{authQuery.error.message}</p>
        <button className="button secondary" onClick={() => authQuery.refetch()}>
          Try again
        </button>
      </main>
    );
  if (!authQuery.data) return <Login onLogin={login} />;
  return (
    <Workspace user={authQuery.data.user} csrfToken={authQuery.data.csrfToken} onLogout={logout} />
  );
}
