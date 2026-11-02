import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import QRScanner from '../../components/QRScanner.jsx';
import {
  listQueuedArrivals,
  queueArrival,
  removeQueuedArrival,
  loadOfflineFlats,
  saveOfflineFlats,
  updateQueuedArrival,
} from './offline-arrivals.js';

async function api(path, { method = 'GET', body, csrfToken } = {}) {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    signal: AbortSignal.timeout(8000),
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

const freshPass = () => ({
  flatId: '',
  visitorName: '',
  visitorPhone: '',
  purpose: '',
  expectedAt: '',
});

const freshRecurringAuthorization = () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return {
    flatId: '',
    visitorName: '',
    visitorPhone: '',
    visitorType: 'DOMESTIC_WORKER',
    purpose: 'Regular domestic work',
    validFrom: today,
    validUntil: today,
    weekdays: [1, 2, 3, 4, 5],
    startTime: '07:00',
    endTime: '22:00',
  };
};

const weekdays = [
  ['Sunday', 0],
  ['Monday', 1],
  ['Tuesday', 2],
  ['Wednesday', 3],
  ['Thursday', 4],
  ['Friday', 5],
  ['Saturday', 6],
];

const visitorKinds = [
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'GUEST', label: 'Guest' },
  { value: 'DOMESTIC_WORKER', label: 'Domestic worker' },
  { value: 'SERVICE_PERSONNEL', label: 'Service Personnel' },
  { value: 'CAB_RIDE', label: 'Cab driver' },
  { value: 'VENDOR', label: 'Vendor' },
  { value: 'CONSTRUCTION_WORKER', label: 'Construction' },
  { value: 'MOVING_SERVICE', label: 'Moving service' },
  { value: 'EMERGENCY_SERVICE', label: 'Emergency' },
  { value: 'EVENT_GUEST', label: 'Event guest' },
];

const visitorStatus = {
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved · verify identity',
  EXPECTED: 'Pre-approved',
  CHECKED_IN: 'Inside',
  CHECKED_OUT: 'Exited',
  REJECTED: 'Declined',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

function statusTone(status) {
  if (status === 'CHECKED_IN') return 'inside';
  if (status === 'PENDING_APPROVAL') return 'pending';
  if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') return 'closed';
  return 'complete';
}

export default function VisitorsPage({ society, csrfToken, role }) {
  const root = `/societies/${society.id}/visitors`;
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(freshPass);
  const [verifyCode, setVerifyCode] = useState('');
  const [createdPass, setCreatedPass] = useState(null);
  const [passQr, setPassQr] = useState('');
  const [checkedIn, setCheckedIn] = useState(null);
  const [error, setError] = useState('');
  const [arrivalNotice, setArrivalNotice] = useState('');
  const [isOnline, setIsOnline] = useState(globalThis.navigator?.onLine !== false);
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [offlineFlats, setOfflineFlats] = useState([]);
  const [guardTab, setGuardTab] = useState('quick');
  const [guardKind, setGuardKind] = useState('GUEST');
  const [guardForm, setGuardForm] = useState({
    visitorName: '',
    visitorPhone: '',
    identityConfirmed: false,
    flatId: '',
    purpose: '',
    vehicleNumber: '',
    vehicleType: '',
    parkingLocation: '',
    parkingAlert: false,
    groupSize: 1,
    expectedDurationMinutes: 240,
    deliveryPlatform: '',
  });
  const [historySearch, setHistorySearch] = useState('');
  const [incidentForm, setIncidentForm] = useState({
    category: 'SUSPICIOUS_ACTIVITY',
    severity: 'MEDIUM',
    location: '',
    description: '',
  });
  const [recurringForm, setRecurringForm] = useState(freshRecurringAuthorization);
  const [handoverNotes, setHandoverNotes] = useState('');
  const isGuard = role === 'SECURITY_GUARD';
  const passesQuery = useQuery({
    queryKey: ['visitor-passes', society.id],
    queryFn: () => api(`${root}/passes`),
    enabled: isOnline,
    refetchInterval: 15_000,
  });
  const historyQuery = useInfiniteQuery({
    queryKey: ['visitor-history', society.id, historySearch],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      api(
        `${root}/history?search=${encodeURIComponent(historySearch.trim())}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: isGuard && guardTab === 'history',
  });
  const approvalsQuery = useQuery({
    queryKey: ['visitor-approvals', society.id],
    queryFn: () => api(`${root}/approvals`),
    enabled: passesQuery.data?.role === 'RESIDENT',
    refetchInterval: 15_000,
  });
  const recurringAuthorizationsQuery = useQuery({
    queryKey: ['recurring-visitor-authorizations', society.id],
    queryFn: () => api(`${root}/recurring-authorizations`),
    enabled: passesQuery.data?.role === 'RESIDENT',
    refetchInterval: 30_000,
  });
  const incidentsQuery = useQuery({
    queryKey: ['guard-incidents', society.id],
    queryFn: () => api(`${root}/incidents`),
    enabled:
      passesQuery.data?.role === 'SECURITY_GUARD' && ['incidents', 'handover'].includes(guardTab),
  });
  const handoversQuery = useQuery({
    queryKey: ['guard-handovers', society.id],
    queryFn: () => api(`${root}/handovers`),
    enabled: passesQuery.data?.role === 'SECURITY_GUARD' && guardTab === 'handover',
  });
  const emergencyQuery = useQuery({
    queryKey: ['guard-emergency', society.id],
    queryFn: () => api(`${root}/emergency`),
    enabled: isGuard && ['active', 'emergency'].includes(guardTab),
    refetchInterval: 5_000,
  });
  const refreshOfflineQueue = useCallback(async () => {
    try {
      setOfflineQueue(await listQueuedArrivals());
    } catch (cause) {
      setError(cause.message);
    }
  }, []);
  const syncOfflineQueue = useCallback(async () => {
    if (!isOnline || !isGuard) return;
    let items;
    try {
      items = await listQueuedArrivals();
    } catch (cause) {
      setError(cause.message);
      return;
    }
    for (const item of items) {
      if (item.state !== 'QUEUED') continue;
      const body = { ...item };
      delete body.state;
      delete body.error;
      delete body.id;
      delete body.createdAt;
      try {
        await api(`${root}/arrivals`, { method: 'POST', csrfToken, body });
        await removeQueuedArrival(item.id);
      } catch (cause) {
        if (cause.status && cause.status < 500) {
          await updateQueuedArrival(item.id, { state: 'CONFLICT', error: cause.message });
        }
      }
    }
    await refreshOfflineQueue();
    queryClient.invalidateQueries({ queryKey: ['visitor-passes', society.id] });
  }, [csrfToken, isGuard, isOnline, queryClient, refreshOfflineQueue, root, society.id]);
  useEffect(() => {
    if (!isGuard) return undefined;
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    refreshOfflineQueue();
    loadOfflineFlats()
      .then((cached) => setOfflineFlats(cached))
      .catch(() => {});
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [isGuard, refreshOfflineQueue]);
  useEffect(() => {
    if (isGuard && flatsQuery.data?.flats) {
      setOfflineFlats(flatsQuery.data.flats);
      saveOfflineFlats(flatsQuery.data.flats).catch(() => {});
    }
  }, [flatsQuery.data, isGuard]);
  useEffect(() => {
    syncOfflineQueue();
  }, [syncOfflineQueue]);
  useEffect(() => {
    let current = true;
    if (!createdPass?.code) {
      setPassQr('');
      return undefined;
    }
    QRCode.toDataURL(createdPass.code, { width: 220, margin: 2, errorCorrectionLevel: 'M' })
      .then((dataUrl) => {
        if (current) setPassQr(dataUrl);
      })
      .catch(() => {
        if (current) setPassQr('');
      });
    return () => {
      current = false;
    };
  }, [createdPass]);
  const flatsQuery = useQuery({
    queryKey: ['visitor-flats', society.id],
    queryFn: () => api(`${root}/flats`),
    enabled: isOnline && (passesQuery.data?.canCreate === true || isGuard),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['visitor-passes', society.id] });
  const createMutation = useMutation({
    mutationFn: () =>
      api(`${root}/passes`, {
        method: 'POST',
        csrfToken,
        body: {
          ...form,
          visitorPhone: form.visitorPhone || null,
          expectedAt: new Date(form.expectedAt).toISOString(),
        },
      }),
    onSuccess: (result) => {
      setCreatedPass(result);
      setShowForm(false);
      setForm(freshPass());
      setError('');
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const checkInMutation = useMutation({
    mutationFn: (value) => {
      const code = typeof value === 'string' ? value : (value?.code ?? verifyCode.trim());
      return api(`${root}/verify`, { method: 'POST', csrfToken, body: { code } });
    },
    onSuccess: (result) => {
      setCheckedIn(result.pass);
      setVerifyCode('');
      setError('');
      refresh();
      queryClient.invalidateQueries({ queryKey: ['guard-emergency', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const actionMutation = useMutation({
    mutationFn: ({ pass, action }) =>
      api(
        action === 'enter'
          ? `${root}/arrivals/${pass.id}/enter`
          : `${root}/passes/${pass.id}/${action}`,
        { method: 'POST', csrfToken, body: {} },
      ),
    onSuccess: () => {
      setError('');
      refresh();
      queryClient.invalidateQueries({ queryKey: ['guard-emergency', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const arrivalMutation = useMutation({
    mutationFn: async () => {
      const body = { ...guardForm, visitorType: guardKind, clientRequestId: crypto.randomUUID() };
      if (!isOnline) {
        await queueArrival(body);
        return { queuedOffline: true };
      }
      try {
        return await api(`${root}/arrivals`, { method: 'POST', csrfToken, body });
      } catch (cause) {
        if (cause.status && cause.status < 500) throw cause;
        await queueArrival(body);
        return { queuedOffline: true };
      }
    },
    onSuccess: (result) => {
      setGuardForm({
        visitorName: '',
        visitorPhone: '',
        identityConfirmed: false,
        flatId: '',
        purpose: '',
        vehicleNumber: '',
        vehicleType: '',
        parkingLocation: '',
        parkingAlert: false,
        groupSize: 1,
        expectedDurationMinutes: 240,
        deliveryPlatform: '',
      });
      setGuardTab(result.recurringAuthorizationApplied ? 'expected' : 'pending');
      setError('');
      if (result.queuedOffline) {
        setArrivalNotice(
          'Saved securely on this device. It is not approved or admitted until it syncs and the resident authorizes entry.',
        );
        refreshOfflineQueue();
      } else {
        setArrivalNotice(
          result.recurringAuthorizationApplied
            ? 'Recurring resident authorization matched. Verify identity and record entry from Expected Visitors.'
            : result.approvalNotificationSent
              ? 'Resident approval request was sent. Entry remains blocked until approval.'
              : 'Arrival recorded. Resident email notification did not send; contact the resident before entry.',
        );
        refresh();
        queryClient.invalidateQueries({ queryKey: ['guard-emergency', society.id] });
      }
    },
    onError: (cause) => setError(cause.message),
  });
  const residentDecisionMutation = useMutation({
    mutationFn: ({ pass, decision }) =>
      api(`${root}/arrivals/${pass.id}/${decision}`, { method: 'POST', csrfToken, body: {} }),
    onSuccess: () => {
      setError('');
      queryClient.invalidateQueries({ queryKey: ['visitor-approvals', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const recurringAuthorizationMutation = useMutation({
    mutationFn: () => {
      const toMinutes = (time) => {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
      };
      return api(`${root}/recurring-authorizations`, {
        method: 'POST',
        csrfToken,
        body: {
          ...recurringForm,
          weekdays: recurringForm.weekdays.map(Number),
          startMinute: toMinutes(recurringForm.startTime),
          endMinute: toMinutes(recurringForm.endTime),
        },
      });
    },
    onSuccess: () => {
      setRecurringForm(freshRecurringAuthorization());
      setError('');
      queryClient.invalidateQueries({ queryKey: ['recurring-visitor-authorizations', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const revokeRecurringAuthorizationMutation = useMutation({
    mutationFn: (authorization) =>
      api(`${root}/recurring-authorizations/${authorization.id}/revoke`, {
        method: 'POST',
        csrfToken,
        body: {},
      }),
    onSuccess: () => {
      setError('');
      queryClient.invalidateQueries({ queryKey: ['recurring-visitor-authorizations', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const destinationMutation = useMutation({
    mutationFn: ({ pass, flatId }) =>
      api(`${root}/arrivals/${pass.id}/destination`, {
        method: 'PATCH',
        csrfToken,
        body: { flatId },
      }),
    onSuccess: () => refresh(),
    onError: (cause) => setError(cause.message),
  });
  const incidentMutation = useMutation({
    mutationFn: () => api(`${root}/incidents`, { method: 'POST', csrfToken, body: incidentForm }),
    onSuccess: () => {
      setIncidentForm({
        category: 'SUSPICIOUS_ACTIVITY',
        severity: 'MEDIUM',
        location: '',
        description: '',
      });
      setError('');
      queryClient.invalidateQueries({ queryKey: ['guard-incidents', society.id] });
    },
    onError: (cause) => setError(cause.message),
  });
  const resolveIncidentMutation = useMutation({
    mutationFn: (incident) =>
      api(`${root}/incidents/${incident.id}/resolve`, { method: 'POST', csrfToken, body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['guard-incidents', society.id] }),
    onError: (cause) => setError(cause.message),
  });
  const handoverMutation = useMutation({
    mutationFn: () =>
      api(`${root}/handovers`, { method: 'POST', csrfToken, body: { notes: handoverNotes } }),
    onSuccess: () => {
      setHandoverNotes('');
      queryClient.invalidateQueries({ queryKey: ['guard-handovers', society.id] });
      setError('');
    },
    onError: (cause) => setError(cause.message),
  });
  const deliveryMutation = useMutation({
    mutationFn: ({ pass, outcome }) =>
      api(`${root}/passes/${pass.id}/delivery-handover`, {
        method: 'POST',
        csrfToken,
        body: { outcome },
      }),
    onSuccess: () => refresh(),
    onError: (cause) => setError(cause.message),
  });
  if (passesQuery.isPending && !(isGuard && !isOnline))
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading visitor passes…
      </section>
    );
  if (passesQuery.isError && !isGuard)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load visitor passes</h2>
        <p>{passesQuery.error.message}</p>
        <button className="button secondary" onClick={() => passesQuery.refetch()}>
          Try again
        </button>
      </section>
    );
  const passData = passesQuery.data ?? {
    passes: [],
    canManage: isGuard,
    canCreate: false,
    role,
    metrics: { entriesToday: 0, inside: 0, pendingApprovals: 0, completedExits: 0 },
  };
  const { passes, canManage, canCreate } = passData;
  const flats = flatsQuery.data?.flats ?? offlineFlats;
  const pendingResidentApprovals =
    approvalsQuery.data?.arrivals?.filter((pass) => pass.status === 'PENDING_APPROVAL') ?? [];
  const residentApprovalHistory =
    approvalsQuery.data?.arrivals?.filter((pass) => pass.status !== 'PENDING_APPROVAL') ?? [];
  if (isGuard) {
    const pending = passes.filter((pass) => pass.status === 'PENDING_APPROVAL');
    const expected = passes.filter((pass) => ['APPROVED', 'EXPECTED'].includes(pass.status));
    // The emergency endpoint is the authoritative, uncapped list of everyone currently inside.
    const active = emergencyQuery.data?.visitors ?? [];
    const deliveries = passes.filter((pass) => pass.visitorType === 'DELIVERY');
    const vehicles = passes.filter((pass) => Boolean(pass.vehicleNumber));
    const history = historyQuery.data?.pages.flatMap((page) => page.passes) ?? [];
    const metrics = passData.metrics ?? {
      entriesToday: 0,
      inside: 0,
      pendingApprovals: 0,
      completedExits: 0,
    };
    const tabButton = (key, label, count) => (
      <button
        className={`guard-tab${guardTab === key ? ' active' : ''}`}
        type="button"
        key={key}
        onClick={() => setGuardTab(key)}
      >
        {label}
        {typeof count === 'number' && <span>{count}</span>}
      </button>
    );
    const visitorCard = (pass, actions) => (
      <article className="guard-visitor-card" key={pass.id}>
        <div className="guard-visitor-main">
          <div>
            <strong>{pass.visitorName}</strong>
            <span>
              {pass.visitorPhone || 'No mobile'} ·{' '}
              {visitorKinds.find((kind) => kind.value === pass.visitorType)?.label ?? 'Guest'}
            </span>
          </div>
          <span className={`guard-status ${statusTone(pass.status)}`}>
            {visitorStatus[pass.status] ?? pass.status}
          </span>
          {pass.status === 'CHECKED_IN' &&
            pass.checkedInAt &&
            Date.now() - new Date(pass.checkedInAt).getTime() >
              (pass.expectedDurationMinutes ?? 240) * 60_000 && (
              <span className="guard-status pending">Over expected duration</span>
            )}
        </div>
        <div className="guard-visitor-meta">
          <span>
            <b>
              {pass.flat.building.name} · {pass.flat.flatNumber}
            </b>
          </span>
          <span>{pass.purpose}</span>
          {pass.vehicleNumber && (
            <span>
              Vehicle {pass.vehicleNumber}
              {pass.vehicleType ? ` · ${pass.vehicleType}` : ''}
            </span>
          )}
          {pass.parkingLocation && <span>Parking {pass.parkingLocation}</span>}
          {pass.parkingAlert && <span className="guard-status pending">Parking alert</span>}
          {pass.groupSize > 1 && <span>Group of {pass.groupSize}</span>}
          {pass.deliveryPlatform && <span>{pass.deliveryPlatform}</span>}
          {pass.deliveryHandoverStatus && pass.deliveryHandoverStatus !== 'NOT_RECORDED' && (
            <span>Handover: {pass.deliveryHandoverStatus.replaceAll('_', ' ').toLowerCase()}</span>
          )}
          <span>
            {pass.checkedInAt
              ? `Entry ${new Date(pass.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : `Arrived ${new Date(pass.createdAt ?? pass.expectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          </span>
        </div>
        {actions && <div className="guard-card-actions">{actions(pass)}</div>}
      </article>
    );
    return (
      <div className="guard-desk">
        <section className="guard-heading">
          <div>
            <p className="eyebrow">GATE OPERATIONS</p>
            <h2>Quick Entry</h2>
            <p>{society.name} · Security desk</p>
          </div>
          <button
            className="button secondary guard-refresh"
            onClick={() => {
              passesQuery.refetch();
              queryClient.invalidateQueries({ queryKey: ['guard-emergency', society.id] });
              queryClient.invalidateQueries({ queryKey: ['guard-incidents', society.id] });
              queryClient.invalidateQueries({ queryKey: ['guard-handovers', society.id] });
              queryClient.invalidateQueries({ queryKey: ['visitor-history', society.id] });
            }}
          >
            Refresh
          </button>
        </section>
        <div className={`guard-connection ${isOnline ? 'online' : 'offline'}`} role="status">
          {isOnline
            ? 'Online · gate records sync to SocietyOS'
            : 'Offline · new arrivals are saved encrypted on this device; entry remains blocked until approval syncs'}
          {offlineQueue.length > 0 && <span>{offlineQueue.length} unsynced</span>}
          {isOnline && offlineQueue.some((item) => item.state === 'QUEUED') && (
            <button type="button" className="text-button" onClick={syncOfflineQueue}>
              Sync now
            </button>
          )}
        </div>
        {arrivalNotice && (
          <p className="success-message" role="status">
            {arrivalNotice}
          </p>
        )}
        <section className="guard-metrics" aria-label="Today's gate activity">
          {[
            ['Today’s entries', metrics.entriesToday],
            ['Inside now', metrics.inside],
            ['Pending approval', metrics.pendingApprovals],
            ['Exited today', metrics.completedExits],
          ].map(([label, value]) => (
            <div className="guard-metric" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <nav className="guard-tabs" aria-label="Gate operations">
          {tabButton('quick', 'Quick Entry')}
          {tabButton('pending', 'Pending Approvals', pending.length)}
          {tabButton('expected', 'Expected Visitors', expected.length)}
          {tabButton('active', 'Active Visitors', metrics.inside)}
          {tabButton('deliveries', 'Delivery Log', deliveries.length)}
          {tabButton('vehicles', 'Vehicle Log', vehicles.length)}
          {tabButton('scanner', 'QR Scanner')}
          {tabButton('history', 'Visitor History')}
          {tabButton('incidents', 'Incident Reports')}
          {tabButton('handover', 'Shift Handover')}
          {tabButton('emergency', 'Emergency Mode', metrics.inside)}
        </nav>
        {guardTab === 'quick' && (
          <div className="guard-work-grid">
            <section className="guard-panel">
              <div className="guard-panel-heading">
                <div>
                  <h3>Register arrival</h3>
                  <p>Confirm host approval before admitting the visitor.</p>
                </div>
              </div>
              <div className="guard-kind-picker" aria-label="Visitor type">
                {visitorKinds.map((kind) => (
                  <button
                    type="button"
                    key={kind.value}
                    className={guardKind === kind.value ? 'selected' : ''}
                    onClick={() => setGuardKind(kind.value)}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
              <form
                className="guard-entry-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError('');
                  arrivalMutation.mutate();
                }}
              >
                <label className="field">
                  <span>Visitor name</span>
                  <input
                    autoFocus
                    required
                    minLength={2}
                    maxLength={160}
                    value={guardForm.visitorName}
                    onChange={(event) =>
                      setGuardForm({ ...guardForm, visitorName: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Mobile number</span>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    required
                    pattern="\+?[1-9][0-9]{7,14}"
                    maxLength={16}
                    placeholder="+91…"
                    value={guardForm.visitorPhone}
                    onChange={(event) =>
                      setGuardForm({
                        ...guardForm,
                        visitorPhone: event.target.value.replace(/[\s()-]/g, ''),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Destination flat</span>
                  <select
                    required
                    value={guardForm.flatId}
                    onChange={(event) => setGuardForm({ ...guardForm, flatId: event.target.value })}
                  >
                    <option value="">Select building and flat</option>
                    {flats.map((flat) => (
                      <option key={flat.id} value={flat.id}>
                        {flat.building.name} · {flat.flatNumber}
                      </option>
                    ))}
                  </select>
                </label>
                {[
                  'DELIVERY',
                  'CAB_RIDE',
                  'SERVICE_PERSONNEL',
                  'VENDOR',
                  'CONSTRUCTION_WORKER',
                  'MOVING_SERVICE',
                ].includes(guardKind) && (
                  <label className="field">
                    <span>Vehicle number (optional)</span>
                    <input
                      autoCapitalize="characters"
                      maxLength={20}
                      value={guardForm.vehicleNumber}
                      onChange={(event) =>
                        setGuardForm({
                          ...guardForm,
                          vehicleNumber: event.target.value.toUpperCase(),
                        })
                      }
                    />
                  </label>
                )}
                {[
                  'DELIVERY',
                  'CAB_RIDE',
                  'SERVICE_PERSONNEL',
                  'VENDOR',
                  'CONSTRUCTION_WORKER',
                  'MOVING_SERVICE',
                ].includes(guardKind) && (
                  <>
                    <label className="field">
                      <span>Vehicle type</span>
                      <select
                        value={guardForm.vehicleType}
                        onChange={(event) =>
                          setGuardForm({ ...guardForm, vehicleType: event.target.value })
                        }
                      >
                        <option value="">Select vehicle type</option>
                        {['Two-wheeler', 'Car', 'Van', 'Truck', 'Other'].map((vehicle) => (
                          <option key={vehicle}>{vehicle}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Parking location (optional)</span>
                      <input
                        maxLength={80}
                        value={guardForm.parkingLocation}
                        onChange={(event) =>
                          setGuardForm({ ...guardForm, parkingLocation: event.target.value })
                        }
                      />
                    </label>
                    <label className="guard-check-field">
                      <input
                        type="checkbox"
                        checked={guardForm.parkingAlert}
                        onChange={(event) =>
                          setGuardForm({ ...guardForm, parkingAlert: event.target.checked })
                        }
                      />
                      Flag parking for review
                    </label>
                  </>
                )}
                {['EVENT_GUEST', 'MOVING_SERVICE'].includes(guardKind) && (
                  <label className="field">
                    <span>Group size</span>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={guardForm.groupSize}
                      onChange={(event) =>
                        setGuardForm({ ...guardForm, groupSize: Number(event.target.value) })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  <span>Expected visit duration</span>
                  <select
                    value={guardForm.expectedDurationMinutes}
                    onChange={(event) =>
                      setGuardForm({
                        ...guardForm,
                        expectedDurationMinutes: Number(event.target.value),
                      })
                    }
                  >
                    {[
                      [60, '1 hour'],
                      [120, '2 hours'],
                      [240, '4 hours'],
                      [480, '8 hours'],
                      [1440, '24 hours'],
                    ].map(([minutes, label]) => (
                      <option value={minutes} key={minutes}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {guardKind === 'DELIVERY' && (
                  <label className="field">
                    <span>Delivery platform</span>
                    <select
                      value={guardForm.deliveryPlatform}
                      onChange={(event) =>
                        setGuardForm({ ...guardForm, deliveryPlatform: event.target.value })
                      }
                    >
                      <option value="">Select platform</option>
                      {['Food delivery', 'E-commerce', 'Grocery', 'Courier', 'Other'].map(
                        (platform) => (
                          <option key={platform}>{platform}</option>
                        ),
                      )}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span>Purpose</span>
                  <input
                    required
                    minLength={2}
                    maxLength={200}
                    placeholder={
                      guardKind === 'DELIVERY'
                        ? 'Package or order'
                        : guardKind === 'SERVICE_PERSONNEL'
                          ? 'Work being carried out'
                          : 'Visit purpose'
                    }
                    value={guardForm.purpose}
                    onChange={(event) =>
                      setGuardForm({ ...guardForm, purpose: event.target.value })
                    }
                  />
                </label>
                {flatsQuery.isError && (
                  <p className="form-message" role="alert">
                    {flatsQuery.error.message}
                  </p>
                )}
                <button
                  className="button primary guard-submit"
                  disabled={arrivalMutation.isPending || flatsQuery.isPending || !flats.length}
                >
                  {arrivalMutation.isPending ? 'Registering…' : 'Add to pending approvals'}
                </button>
              </form>
            </section>
            <section className="guard-panel guard-scanner-panel">
              <div className="guard-panel-heading">
                <div>
                  <h3>Verify visitor pass</h3>
                  <p>Scan a resident-issued QR code to record entry.</p>
                </div>
              </div>
              <form
                className="visitor-verify guard-verify"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError('');
                  checkInMutation.mutate();
                }}
              >
                <input
                  aria-label="Visitor pass code"
                  autoComplete="off"
                  placeholder="Enter pass code"
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                />
                <button
                  className="button secondary"
                  disabled={checkInMutation.isPending || !verifyCode.trim()}
                >
                  {checkInMutation.isPending ? 'Checking…' : 'Verify pass'}
                </button>
                <QRScanner
                  label="visitor pass"
                  onError={setError}
                  onCode={(code) => {
                    setVerifyCode(code);
                    setError('');
                    checkInMutation.mutate({ code });
                  }}
                />
              </form>
              {checkedIn && (
                <p className="success-message" role="status">
                  {checkedIn.visitorName} checked in · {checkedIn.flat.building.name}{' '}
                  {checkedIn.flat.flatNumber}
                </p>
              )}
            </section>
          </div>
        )}
        {guardTab === 'pending' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Pending approvals</h3>
                <p>Waiting for the destination resident to respond.</p>
              </div>
            </div>
            {pending.length ? (
              <div className="guard-visitor-list">
                {pending.map((pass) =>
                  visitorCard(pass, (item) => (
                    <>
                      <span className="guard-waiting">Resident decision required</span>
                      <select
                        aria-label={`Change destination for ${item.visitorName}`}
                        value={item.flatId}
                        onChange={(event) =>
                          destinationMutation.mutate({ pass: item, flatId: event.target.value })
                        }
                        disabled={destinationMutation.isPending}
                      >
                        {flats.map((flat) => (
                          <option key={flat.id} value={flat.id}>
                            {flat.building.name} · {flat.flatNumber}
                          </option>
                        ))}
                      </select>
                    </>
                  )),
                )}
              </div>
            ) : (
              <p className="guard-empty">No visitors are waiting for approval.</p>
            )}
            {offlineQueue.length > 0 && (
              <div className="guard-visitor-list offline-arrival-list">
                {offlineQueue.map((item) => (
                  <article className="guard-visitor-card" key={item.id}>
                    <div className="guard-visitor-main">
                      <div>
                        <strong>{item.visitorName}</strong>
                        <span>
                          {item.visitorPhone} ·{' '}
                          {visitorKinds.find((kind) => kind.value === item.visitorType)?.label ??
                            'Visitor'}
                        </span>
                      </div>
                      <span
                        className={`guard-status ${item.state === 'CONFLICT' ? 'closed' : 'pending'}`}
                      >
                        {item.state === 'CONFLICT' ? 'Sync conflict' : 'Not synced'}
                      </span>
                    </div>
                    <div className="guard-visitor-meta">
                      <b>
                        {flats.find((flat) => flat.id === item.flatId)
                          ? `${flats.find((flat) => flat.id === item.flatId).building.name} · ${flats.find((flat) => flat.id === item.flatId).flatNumber}`
                          : 'Destination saved'}
                      </b>
                      <span>{item.purpose}</span>
                    </div>
                    <p className="guard-waiting">
                      Not authorized for entry. Resident approval is required after sync.
                    </p>
                    {item.error && (
                      <p className="form-message" role="alert">
                        {item.error}
                      </p>
                    )}
                    <div className="guard-card-actions">
                      {item.state === 'QUEUED' && isOnline && (
                        <button className="button primary compact" onClick={syncOfflineQueue}>
                          Retry sync
                        </button>
                      )}
                      {item.state === 'CONFLICT' && (
                        <button
                          className="button secondary compact"
                          onClick={() => removeQueuedArrival(item.id).then(refreshOfflineQueue)}
                        >
                          Remove draft
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
        {guardTab === 'expected' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Expected visitors</h3>
                <p>Verify identity and destination before admitting authorized visitors.</p>
              </div>
            </div>
            {expected.length ? (
              <div className="guard-visitor-list">
                {expected.map((pass) =>
                  visitorCard(pass, (item) => (
                    <>
                      {pass.status === 'APPROVED' ? (
                        <button
                          className="button primary compact"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({ pass: item, action: 'enter' })}
                        >
                          Verify &amp; admit
                        </button>
                      ) : (
                        <span className="guard-waiting">Scan resident QR pass to admit</span>
                      )}
                      <select
                        aria-label={`Change destination for ${item.visitorName}`}
                        value={item.flatId}
                        onChange={(event) =>
                          destinationMutation.mutate({ pass: item, flatId: event.target.value })
                        }
                        disabled={destinationMutation.isPending}
                      >
                        {flats.map((flat) => (
                          <option key={flat.id} value={flat.id}>
                            {flat.building.name} · {flat.flatNumber}
                          </option>
                        ))}
                      </select>
                    </>
                  )),
                )}
              </div>
            ) : (
              <p className="guard-empty">No expected visitors are waiting.</p>
            )}
          </section>
        )}
        {guardTab === 'active' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Active visitors</h3>
                <p>Visitors currently recorded inside the society.</p>
              </div>
            </div>
            {emergencyQuery.isError && (
              <p className="form-message" role="alert">
                {emergencyQuery.error.message}
              </p>
            )}
            {active.length ? (
              <div className="guard-visitor-list">
                {active.map((pass) =>
                  visitorCard(pass, (item) => (
                    <button
                      className="button primary compact"
                      disabled={actionMutation.isPending}
                      onClick={() => actionMutation.mutate({ pass: item, action: 'checkout' })}
                    >
                      Record exit
                    </button>
                  )),
                )}
              </div>
            ) : (
              <p className="guard-empty">
                {emergencyQuery.isPending
                  ? 'Loading live visitor list…'
                  : 'No visitors are currently inside.'}
              </p>
            )}
          </section>
        )}
        {guardTab === 'deliveries' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Delivery log</h3>
                <p>Food, grocery, courier and e-commerce arrivals.</p>
              </div>
            </div>
            {deliveries.length ? (
              <div className="guard-visitor-list">
                {deliveries.map((pass) =>
                  visitorCard(
                    pass,
                    pass.status === 'CHECKED_IN' && pass.deliveryHandoverStatus === 'NOT_RECORDED'
                      ? (item) => (
                          <>
                            <button
                              className="button primary compact"
                              disabled={deliveryMutation.isPending}
                              onClick={() =>
                                deliveryMutation.mutate({ pass: item, outcome: 'HANDED_AT_GATE' })
                              }
                            >
                              Handed at gate
                            </button>
                            <button
                              className="button secondary compact"
                              disabled={deliveryMutation.isPending}
                              onClick={() =>
                                deliveryMutation.mutate({ pass: item, outcome: 'TAKEN_DOORSTEP' })
                              }
                            >
                              Doorstep access
                            </button>
                            <button
                              className="button secondary compact"
                              disabled={deliveryMutation.isPending}
                              onClick={() =>
                                deliveryMutation.mutate({ pass: item, outcome: 'REFUSED' })
                              }
                            >
                              Refused
                            </button>
                          </>
                        )
                      : undefined,
                  ),
                )}
              </div>
            ) : (
              <p className="guard-empty">No delivery records yet.</p>
            )}
          </section>
        )}
        {guardTab === 'vehicles' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Vehicle log</h3>
                <p>Vehicles connected to visitor entries and exits.</p>
              </div>
            </div>
            {vehicles.length ? (
              <div className="guard-visitor-list">{vehicles.map((pass) => visitorCard(pass))}</div>
            ) : (
              <p className="guard-empty">No visitor vehicles recorded yet.</p>
            )}
          </section>
        )}
        {guardTab === 'scanner' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>QR pass scanner</h3>
                <p>Scan or enter a resident-issued pass. Expired and reused codes are rejected.</p>
              </div>
            </div>
            <form
              className="visitor-verify guard-verify"
              onSubmit={(event) => {
                event.preventDefault();
                setError('');
                checkInMutation.mutate();
              }}
            >
              <input
                aria-label="Visitor pass code"
                autoComplete="off"
                placeholder="Enter pass code"
                value={verifyCode}
                onChange={(event) => setVerifyCode(event.target.value)}
              />
              <button
                className="button primary"
                disabled={checkInMutation.isPending || !verifyCode.trim()}
              >
                {checkInMutation.isPending ? 'Checking…' : 'Verify & record entry'}
              </button>
              <QRScanner
                label="visitor pass"
                onError={setError}
                onCode={(code) => {
                  setVerifyCode(code);
                  checkInMutation.mutate({ code });
                }}
              />
            </form>
          </section>
        )}
        {guardTab === 'emergency' && (
          <section className="guard-panel emergency-panel">
            <div className="guard-panel-heading">
              <div>
                <p className="eyebrow">EVACUATION HEADCOUNT</p>
                <h3>Visitors currently inside</h3>
                <p>Live society-wide list for emergency roll call.</p>
              </div>
              <strong className="emergency-count">{emergencyQuery.data?.count ?? '—'}</strong>
            </div>
            {emergencyQuery.isError && (
              <p className="form-message" role="alert">
                {emergencyQuery.error.message}
              </p>
            )}
            {emergencyQuery.data?.visitors.length ? (
              <div className="guard-visitor-list">
                {emergencyQuery.data.visitors.map((visitor) => (
                  <article className="guard-visitor-card" key={visitor.id}>
                    <div className="guard-visitor-main">
                      <div>
                        <strong>{visitor.visitorName}</strong>
                        <span>
                          {visitor.visitorPhone || 'No mobile'} · entered{' '}
                          {new Date(visitor.checkedInAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <span className="guard-status inside">Inside</span>
                    </div>
                    <div className="guard-visitor-meta">
                      <b>
                        {visitor.flat.building.name} · {visitor.flat.flatNumber}
                      </b>
                      <span>{visitor.purpose}</span>
                      <span>Entry recorded by {visitor.checkedInBy.email}</span>
                      {visitor.vehicleNumber && <span>Vehicle {visitor.vehicleNumber}</span>}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="guard-empty">
                {emergencyQuery.isPending
                  ? 'Loading live visitor list…'
                  : 'No visitors are currently inside.'}
              </p>
            )}
          </section>
        )}
        {guardTab === 'incidents' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Incident reports</h3>
                <p>Report security concerns and emergency events for this society.</p>
              </div>
            </div>
            <form
              className="guard-entry-form"
              onSubmit={(event) => {
                event.preventDefault();
                incidentMutation.mutate();
              }}
            >
              <label className="field">
                <span>Category</span>
                <select
                  value={incidentForm.category}
                  onChange={(event) =>
                    setIncidentForm({ ...incidentForm, category: event.target.value })
                  }
                >
                  {[
                    ['SUSPICIOUS_ACTIVITY', 'Suspicious activity'],
                    ['UNAUTHORIZED_ENTRY', 'Unauthorized entry'],
                    ['LOST_ITEM', 'Lost item'],
                    ['EMERGENCY', 'Emergency'],
                    ['OTHER', 'Other'],
                  ].map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Severity</span>
                <select
                  value={incidentForm.severity}
                  onChange={(event) =>
                    setIncidentForm({ ...incidentForm, severity: event.target.value })
                  }
                >
                  {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Location (optional)</span>
                <input
                  maxLength={160}
                  value={incidentForm.location}
                  onChange={(event) =>
                    setIncidentForm({ ...incidentForm, location: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Incident details</span>
                <textarea
                  required
                  minLength={5}
                  maxLength={2000}
                  value={incidentForm.description}
                  onChange={(event) =>
                    setIncidentForm({ ...incidentForm, description: event.target.value })
                  }
                />
              </label>
              <button className="button primary guard-submit" disabled={incidentMutation.isPending}>
                {incidentMutation.isPending ? 'Saving…' : 'Save incident report'}
              </button>
            </form>
            {incidentsQuery.isError && (
              <p className="form-message" role="alert">
                {incidentsQuery.error.message}
              </p>
            )}
            <div className="guard-incident-list">
              {(incidentsQuery.data?.incidents ?? []).map((incident) => (
                <article className="guard-visitor-card" key={incident.id}>
                  <div className="guard-visitor-main">
                    <strong>
                      {incident.category.replaceAll('_', ' ')} · {incident.severity}
                    </strong>
                    <span
                      className={`guard-status ${incident.status === 'OPEN' ? 'pending' : 'complete'}`}
                    >
                      {incident.status}
                    </span>
                  </div>
                  <p>{incident.description}</p>
                  <div className="guard-visitor-meta">
                    <span>{incident.location || 'Location not specified'}</span>
                    <span>{new Date(incident.createdAt).toLocaleString()}</span>
                    <span>Reported by {incident.reporter.email}</span>
                  </div>
                  {incident.status === 'OPEN' && (
                    <button
                      className="button secondary compact"
                      disabled={resolveIncidentMutation.isPending}
                      onClick={() => resolveIncidentMutation.mutate(incident)}
                    >
                      Mark resolved
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        {guardTab === 'handover' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Shift handover</h3>
                <p>
                  Save a handover with a live count of pending visitors, active entries and
                  incidents.
                </p>
              </div>
            </div>
            <div className="guard-metrics handover-metrics">
              <div className="guard-metric">
                <span>Visitors inside</span>
                <strong>{metrics.inside}</strong>
              </div>
              <div className="guard-metric">
                <span>Pending approvals</span>
                <strong>{metrics.pendingApprovals}</strong>
              </div>
              <div className="guard-metric">
                <span>Open incidents</span>
                <strong>
                  {
                    (incidentsQuery.data?.incidents ?? []).filter(
                      (incident) => incident.status === 'OPEN',
                    ).length
                  }
                </strong>
              </div>
            </div>
            <form
              className="guard-handover-form"
              onSubmit={(event) => {
                event.preventDefault();
                handoverMutation.mutate();
              }}
            >
              <label className="field">
                <span>Handover notes</span>
                <textarea
                  required
                  minLength={3}
                  maxLength={2000}
                  placeholder="Unresolved items, expected arrivals, instructions for the next shift"
                  value={handoverNotes}
                  onChange={(event) => setHandoverNotes(event.target.value)}
                />
              </label>
              <button className="button primary" disabled={handoverMutation.isPending}>
                {handoverMutation.isPending ? 'Saving…' : 'Record shift handover'}
              </button>
            </form>
            {handoversQuery.isError && (
              <p className="form-message" role="alert">
                {handoversQuery.error.message}
              </p>
            )}
            <div className="guard-incident-list">
              {(handoversQuery.data?.handovers ?? []).map((handover) => (
                <article className="guard-visitor-card" key={handover.id}>
                  <div className="guard-visitor-main">
                    <strong>Handover · {new Date(handover.createdAt).toLocaleString()}</strong>
                    <span>{handover.guard.email}</span>
                  </div>
                  <div className="guard-visitor-meta">
                    <span>{handover.activeVisitorsCount} inside</span>
                    <span>{handover.pendingApprovalsCount} pending</span>
                    <span>{handover.openIncidentsCount} open incidents</span>
                  </div>
                  <p>{handover.notes}</p>
                </article>
              ))}
            </div>
          </section>
        )}
        {guardTab === 'history' && (
          <section className="guard-panel">
            <div className="guard-panel-heading">
              <div>
                <h3>Visitor history</h3>
                <p>Search completed and declined arrivals.</p>
              </div>
            </div>
            <input
              className="guard-history-search"
              aria-label="Search visitor history"
              placeholder="Search name, mobile, flat or purpose"
              value={historySearch}
              onChange={(event) => setHistorySearch(event.target.value)}
            />
            {historyQuery.isError && (
              <p className="form-message" role="alert">
                {historyQuery.error.message}
              </p>
            )}
            {historyQuery.isLoading && <p className="guard-empty">Loading visitor history…</p>}
            {history.length ? (
              <div className="guard-visitor-list">{history.map((pass) => visitorCard(pass))}</div>
            ) : (
              !historyQuery.isFetching && (
                <p className="guard-empty">No matching visitor history.</p>
              )
            )}
            {historyQuery.hasNextPage && (
              <button
                className="button secondary guard-load-more"
                disabled={historyQuery.isFetchingNextPage}
                onClick={() => historyQuery.fetchNextPage()}
              >
                {historyQuery.isFetchingNextPage ? 'Loading…' : 'Load more history'}
              </button>
            )}
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="visitors-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">GATE OPERATIONS</p>
          <h2>Visitor management</h2>
          <p>Issue timed passes and record visitor entry and exit.</p>
        </div>
        {canCreate && (
          <button
            className="button primary"
            disabled={flatsQuery.isPending || !flats.length}
            onClick={() => {
              setError('');
              setShowForm(!showForm);
            }}
          >
            ＋ Create visitor pass
          </button>
        )}
      </section>
      {passData.role === 'RESIDENT' && (
        <section className="guard-panel resident-approval-panel">
          <div className="guard-panel-heading">
            <div>
              <h3>Gate approvals</h3>
              <p>Approve or decline arrivals requesting access to your registered flat.</p>
            </div>
            <span className="guard-status pending">{pendingResidentApprovals.length} pending</span>
          </div>
          {approvalsQuery.isError && (
            <p className="form-message" role="alert">
              {approvalsQuery.error.message}
            </p>
          )}
          {pendingResidentApprovals.length ? (
            <div className="guard-visitor-list">
              {pendingResidentApprovals.map((pass) => (
                <article className="guard-visitor-card" key={pass.id}>
                  <div className="guard-visitor-main">
                    <div>
                      <strong>{pass.visitorName}</strong>
                      <span>
                        {pass.visitorPhone} ·{' '}
                        {visitorKinds.find((kind) => kind.value === pass.visitorType)?.label ??
                          'Visitor'}
                      </span>
                    </div>
                    <span className="guard-status pending">Pending approval</span>
                  </div>
                  <div className="guard-visitor-meta">
                    <b>
                      {pass.flat.building.name} · {pass.flat.flatNumber}
                    </b>
                    <span>{pass.purpose}</span>
                    <span>
                      Expires{' '}
                      {new Date(pass.expiresAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="guard-card-actions">
                    <button
                      className="button primary compact"
                      disabled={residentDecisionMutation.isPending}
                      onClick={() => residentDecisionMutation.mutate({ pass, decision: 'approve' })}
                    >
                      Approve arrival
                    </button>
                    <button
                      className="button secondary compact"
                      disabled={residentDecisionMutation.isPending}
                      onClick={() => residentDecisionMutation.mutate({ pass, decision: 'reject' })}
                    >
                      Decline
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !approvalsQuery.isPending && (
              <p className="guard-empty">No gate arrivals need your approval.</p>
            )
          )}
          {residentApprovalHistory.length > 0 && (
            <div className="resident-approval-history">
              <h4>Recent gate requests</h4>
              {residentApprovalHistory.map((pass) => (
                <div key={pass.id}>
                  <span>
                    <b>{pass.visitorName}</b> · {pass.flat.building.name} {pass.flat.flatNumber}
                  </span>
                  <span className={`guard-status ${statusTone(pass.status)}`}>
                    {visitorStatus[pass.status] ?? pass.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {passData.role === 'RESIDENT' && (
        <section className="guard-panel resident-approval-panel">
          <div className="guard-panel-heading">
            <div>
              <h3>Regular worker access</h3>
              <p>
                Authorize recurring domestic workers or service personnel for your registered flats.
              </p>
            </div>
          </div>
          {recurringAuthorizationsQuery.isError && (
            <p className="form-message" role="alert">
              {recurringAuthorizationsQuery.error.message}
            </p>
          )}
          <form
            className="guard-entry-form"
            onSubmit={(event) => {
              event.preventDefault();
              recurringAuthorizationMutation.mutate();
            }}
          >
            <label className="field">
              <span>Destination flat</span>
              <select
                required
                value={recurringForm.flatId}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, flatId: event.target.value })
                }
              >
                <option value="">Select your flat</option>
                {(flatsQuery.data?.flats ?? []).map((flat) => (
                  <option key={flat.id} value={flat.id}>
                    {flat.building.name} · {flat.flatNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Visitor type</span>
              <select
                value={recurringForm.visitorType}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, visitorType: event.target.value })
                }
              >
                <option value="DOMESTIC_WORKER">Domestic worker</option>
                <option value="SERVICE_PERSONNEL">Service personnel</option>
              </select>
            </label>
            <label className="field">
              <span>Visitor name</span>
              <input
                required
                maxLength={100}
                autoComplete="name"
                value={recurringForm.visitorName}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, visitorName: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Mobile number</span>
              <input
                required
                inputMode="tel"
                autoComplete="tel"
                value={recurringForm.visitorPhone}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, visitorPhone: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Purpose</span>
              <input
                required
                maxLength={200}
                value={recurringForm.purpose}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, purpose: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Valid from</span>
              <input
                type="date"
                required
                value={recurringForm.validFrom}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, validFrom: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Valid until</span>
              <input
                type="date"
                required
                min={recurringForm.validFrom}
                value={recurringForm.validUntil}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, validUntil: event.target.value })
                }
              />
            </label>
            <div className="field">
              <span>Authorized days</span>
              <div className="guard-kind-picker">
                {weekdays.map(([day, value]) => (
                  <button
                    className={recurringForm.weekdays.includes(value) ? 'selected' : ''}
                    type="button"
                    aria-pressed={recurringForm.weekdays.includes(value)}
                    key={value}
                    onClick={() =>
                      setRecurringForm({
                        ...recurringForm,
                        weekdays: recurringForm.weekdays.includes(value)
                          ? recurringForm.weekdays.filter((item) => item !== value)
                          : [...recurringForm.weekdays, value].sort((a, b) => a - b),
                      })
                    }
                  >
                    {day.slice(0, 3)}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Daily start</span>
              <input
                type="time"
                required
                value={recurringForm.startTime}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, startTime: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Daily end</span>
              <input
                type="time"
                required
                value={recurringForm.endTime}
                onChange={(event) =>
                  setRecurringForm({ ...recurringForm, endTime: event.target.value })
                }
              />
            </label>
            <button
              className="button primary guard-submit"
              disabled={
                recurringAuthorizationMutation.isPending ||
                !recurringForm.weekdays.length ||
                !flatsQuery.data?.flats?.length
              }
            >
              {recurringAuthorizationMutation.isPending
                ? 'Saving authorization…'
                : 'Authorize regular visitor'}
            </button>
          </form>
          <div className="resident-approval-history">
            <h4>Current and past authorizations</h4>
            {recurringAuthorizationsQuery.data?.authorizations?.length
              ? recurringAuthorizationsQuery.data.authorizations.map((authorization) => (
                  <div key={authorization.id}>
                    <span>
                      <b>{authorization.visitorName}</b> · {authorization.flat.building.name}{' '}
                      {authorization.flat.flatNumber} · {authorization.visitorPhone}
                      <small>
                        {authorization.purpose} ·{' '}
                        {new Date(authorization.validFrom).toLocaleDateString()}–
                        {new Date(authorization.validUntil).toLocaleDateString()}
                      </small>
                    </span>
                    <span className={`guard-status ${authorization.active ? 'inside' : 'closed'}`}>
                      {authorization.active ? 'Active' : 'Revoked'}
                    </span>
                    {authorization.active && (
                      <button
                        className="button secondary compact"
                        disabled={revokeRecurringAuthorizationMutation.isPending}
                        onClick={() => revokeRecurringAuthorizationMutation.mutate(authorization)}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))
              : !recurringAuthorizationsQuery.isPending && (
                  <p className="guard-empty">No regular visitor authorizations recorded.</p>
                )}
          </div>
        </section>
      )}
      {canManage && (
        <form
          className="visitor-verify"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            checkInMutation.mutate();
          }}
        >
          <div>
            <h3>Guard check-in</h3>
            <p>Scan the visitor’s QR pass or enter the one-time access code.</p>
          </div>
          <input
            aria-label="Visitor access code"
            autoComplete="off"
            placeholder="Pass code"
            value={verifyCode}
            onChange={(event) => setVerifyCode(event.target.value)}
          />
          <button
            className="button primary"
            disabled={checkInMutation.isPending || !verifyCode.trim()}
          >
            {checkInMutation.isPending ? 'Verifying…' : 'Verify & check in'}
          </button>
          <QRScanner
            label="visitor pass"
            onError={setError}
            onCode={(code) => {
              setVerifyCode(code);
              setError('');
              checkInMutation.mutate({ code });
            }}
          />
        </form>
      )}
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {createdPass && (
        <section className="visitor-code-card" role="status">
          <div>
            <b>Visitor pass created</b>
            <p>
              Show this one-time code to the visitor. It expires six hours after the expected
              arrival time.
            </p>
            <code>{createdPass.code}</code>
            {passQr && (
              <img className="visitor-qr" src={passQr} alt="One-time visitor pass QR code" />
            )}
            <button
              className="button secondary compact"
              onClick={async () => {
                await navigator.clipboard.writeText(createdPass.code);
              }}
            >
              Copy code
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="Dismiss pass code"
            onClick={() => setCreatedPass(null)}
          >
            ×
          </button>
        </section>
      )}
      {checkedIn && (
        <section className="visitor-code-card checked-in" role="status">
          <div>
            <b>Visitor checked in</b>
            <p>
              {checkedIn.visitorName} · {checkedIn.flat.building.name} {checkedIn.flat.flatNumber}
            </p>
            <small>{checkedIn.purpose}</small>
          </div>
          <button
            className="icon-button"
            aria-label="Dismiss check-in details"
            onClick={() => setCheckedIn(null)}
          >
            ×
          </button>
        </section>
      )}
      {showForm && canCreate && (
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
              <h3>Prepare a visitor pass</h3>
              <p>
                Passes are private, one-use codes that expire six hours after the expected arrival.
              </p>
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
                value={form.flatId}
                onChange={(event) => setForm({ ...form, flatId: event.target.value })}
              >
                <option value="">Choose flat</option>
                {flats.map((flat) => (
                  <option key={flat.id} value={flat.id}>
                    {flat.building.name} · {flat.flatNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                Expected arrival <b>*</b>
              </span>
              <input
                type="datetime-local"
                required
                value={form.expectedAt}
                onChange={(event) => setForm({ ...form, expectedAt: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Visitor name <b>*</b>
              </span>
              <input
                required
                minLength={2}
                maxLength={160}
                value={form.visitorName}
                onChange={(event) => setForm({ ...form, visitorName: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Phone</span>
              <input
                type="tel"
                maxLength={16}
                value={form.visitorPhone}
                onChange={(event) => setForm({ ...form, visitorPhone: event.target.value })}
              />
            </label>
            <label className="field visitor-purpose">
              <span>
                Purpose <b>*</b>
              </span>
              <input
                required
                minLength={2}
                maxLength={200}
                value={form.purpose}
                onChange={(event) => setForm({ ...form, purpose: event.target.value })}
              />
            </label>
          </div>
          {flatsQuery.isError && <p className="form-message">{flatsQuery.error.message}</p>}
          <button className="button primary" disabled={createMutation.isPending || !form.flatId}>
            {createMutation.isPending ? 'Creating…' : 'Create pass'}
          </button>
        </form>
      )}
      {passes.length === 0 ? (
        <section className="state-panel">
          <h2>No visitor passes</h2>
          <p>Upcoming guest passes and gate activity will appear here.</p>
        </section>
      ) : (
        <section className="resident-table-panel">
          <div className="table-overflow">
            <table className="flat-table resident-table">
              <thead>
                <tr>
                  <th>Visitor</th>
                  <th>Flat</th>
                  <th>Purpose</th>
                  <th>Expected</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {passes.map((pass) => (
                  <tr key={pass.id}>
                    <td>
                      <strong>{pass.visitorName}</strong>
                      {pass.visitorPhone && <small>{pass.visitorPhone}</small>}
                    </td>
                    <td>
                      {pass.flat.building.name} · {pass.flat.flatNumber}
                    </td>
                    <td>{pass.purpose}</td>
                    <td>{new Date(pass.expectedAt).toLocaleString()}</td>
                    <td>
                      <span
                        className={`occupancy ${pass.status === 'CHECKED_IN' ? 'occupied' : pass.status === 'EXPECTED' ? 'vacant' : ''}`}
                      >
                        {pass.status.replace('_', ' ')}
                      </span>
                      {pass.checkedInAt && (
                        <small>In {new Date(pass.checkedInAt).toLocaleTimeString()}</small>
                      )}
                      {pass.checkedOutAt && (
                        <small>Out {new Date(pass.checkedOutAt).toLocaleTimeString()}</small>
                      )}
                    </td>
                    <td>
                      {canManage && pass.status === 'CHECKED_IN' && (
                        <button
                          className="text-button"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({ pass, action: 'checkout' })}
                        >
                          Check out
                        </button>
                      )}
                      {canCreate &&
                        pass.status === 'EXPECTED' &&
                        new Date(pass.expectedAt) > new Date() && (
                          <button
                            className="text-button"
                            disabled={actionMutation.isPending}
                            onClick={() => actionMutation.mutate({ pass, action: 'cancel' })}
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
        </section>
      )}
    </div>
  );
}
