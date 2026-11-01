import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

function FormField({ label, name, value, onChange, type = 'text', required = false, maxLength }) {
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
        type={type}
        required={required}
        maxLength={maxLength}
        autoComplete="off"
      />
    </label>
  );
}

function ResidentForm({ society, initial, buildings, csrfToken, onCancel, onSaved }) {
  const [buildingId, setBuildingId] = useState(initial?.flat?.buildingId ?? buildings[0]?.id ?? '');
  const [form, setForm] = useState({
    fullName: initial?.fullName ?? '',
    flatId: initial?.flatId ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    residentType: initial?.residentType ?? 'OWNER',
    emergencyContactName: initial?.emergencyContactName ?? '',
    emergencyContactPhone: initial?.emergencyContactPhone ?? '',
    status: initial?.status ?? 'ACTIVE',
  });
  const path = `/societies/${society.id}`;
  const flatsQuery = useInfiniteQuery({
    queryKey: ['resident-form-flats', society.id, buildingId],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      api(`${path}/buildings/${buildingId}/flats${pageParam ? `?cursor=${pageParam}` : ''}`),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(buildingId),
  });
  const flats = flatsQuery.data?.pages.flatMap((page) => page.flats) ?? [];
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: (body) =>
      api(`${path}/residents${initial ? `/${initial.id}` : ''}`, {
        method: initial ? 'PATCH' : 'POST',
        body,
        csrfToken,
      }),
    onSuccess: onSaved,
    onError: (cause) => setError(cause.message),
  });
  const change = (event) => {
    const { name, value } = event.target;
    if (name === 'buildingId') {
      setBuildingId(value);
      setForm({ ...form, flatId: '' });
      return;
    }
    setForm({ ...form, [name]: value });
  };
  const submit = (event) => {
    event.preventDefault();
    setError('');
    const body = {
      ...form,
      ...(form.status ? { status: form.status } : {}),
    };
    mutation.mutate(body);
  };

  return (
    <form className="form-card resident-form" onSubmit={submit}>
      <div>
        <p className="eyebrow">RESIDENT RECORD</p>
        <h2>{initial ? 'Edit resident' : 'Add a resident'}</h2>
        <p className="muted">Contact information is visible only to society administrators.</p>
      </div>
      <div className="form-grid">
        <FormField
          label="Full name"
          name="fullName"
          value={form.fullName}
          onChange={change}
          required
          maxLength={160}
        />
        <label className="field">
          <span>Resident type</span>
          <select name="residentType" value={form.residentType} onChange={change}>
            <option value="OWNER">Owner</option>
            <option value="TENANT">Tenant</option>
          </select>
        </label>
        <FormField
          label="Email (optional)"
          name="email"
          value={form.email}
          onChange={change}
          type="email"
          maxLength={320}
        />
        <FormField
          label="Phone (optional)"
          name="phone"
          value={form.phone}
          onChange={change}
          type="tel"
          maxLength={16}
        />
        <label className="field">
          <span>Building</span>
          <select name="buildingId" value={buildingId} onChange={change} required>
            <option value="">Select a building</option>
            {buildings.map((building) => (
              <option key={building.id} value={building.id}>
                {building.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Flat</span>
          <select
            name="flatId"
            value={form.flatId}
            onChange={change}
            required
            disabled={!buildingId || flatsQuery.isPending}
          >
            <option value="">Select a flat</option>
            {flats.map((flat) => (
              <option key={flat.id} value={flat.id}>
                {flat.flatNumber} · Floor {flat.floor}
              </option>
            ))}
          </select>
        </label>
        <FormField
          label="Emergency contact name (optional)"
          name="emergencyContactName"
          value={form.emergencyContactName}
          onChange={change}
          maxLength={160}
        />
        <FormField
          label="Emergency contact phone (optional)"
          name="emergencyContactPhone"
          value={form.emergencyContactPhone}
          onChange={change}
          type="tel"
          maxLength={16}
        />
        {initial && (
          <label className="field">
            <span>Record status</span>
            <select name="status" value={form.status} onChange={change}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </label>
        )}
      </div>
      {flatsQuery.isError && (
        <p className="form-message" role="alert">
          {flatsQuery.error.message}
        </p>
      )}
      {flatsQuery.hasNextPage && (
        <button className="text-button" type="button" onClick={() => flatsQuery.fetchNextPage()}>
          Load more flats
        </button>
      )}
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button primary"
          type="submit"
          disabled={mutation.isPending || !flats.length}
        >
          {mutation.isPending ? 'Saving…' : initial ? 'Save resident' : 'Add resident'}
        </button>
      </div>
    </form>
  );
}

export default function ResidentsPage({ society, csrfToken, canManage }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const path = `/societies/${society.id}`;
  const residentsQuery = useInfiniteQuery({
    queryKey: ['residents', society.id, search, status],
    initialPageParam: null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({
        status,
        ...(search ? { search } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      return api(`${path}/residents?${query}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: canManage,
  });
  const buildingsQuery = useInfiniteQuery({
    queryKey: ['buildings', society.id],
    initialPageParam: null,
    queryFn: ({ pageParam }) => api(`${path}/buildings${pageParam ? `?cursor=${pageParam}` : ''}`),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: canManage && (showForm || Boolean(editing)),
  });
  const buildings = buildingsQuery.data?.pages.flatMap((page) => page.buildings) ?? [];
  const residents = residentsQuery.data?.pages.flatMap((page) => page.residents) ?? [];
  const totalCount = residentsQuery.data?.pages.at(-1)?.totalCount ?? 0;
  const onSaved = async () => {
    setShowForm(false);
    setEditing(null);
    await client.invalidateQueries({ queryKey: ['residents', society.id] });
  };

  if (!canManage) {
    return (
      <section className="state-panel error-state">
        <h2>Administrator access required</h2>
        <p>Resident contact details are restricted to society administrators.</p>
      </section>
    );
  }

  return (
    <div className="residents-page">
      <section className="resident-toolbar">
        <div>
          <span className="toolbar-count">{totalCount}</span>
          <span className="muted">
            {status === 'ACTIVE' ? 'active' : 'inactive'} resident records
          </span>
        </div>
        <div className="resident-filters">
          <input
            aria-label="Search residents"
            placeholder="Search residents"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filter resident status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          {canManage && (
            <button
              className="button primary"
              onClick={() => {
                setEditing(null);
                setShowForm((open) => !open);
              }}
            >
              + Add resident
            </button>
          )}
        </div>
      </section>
      {buildingsQuery.isError && (
        <section className="state-panel error-state">
          <p>{buildingsQuery.error.message}</p>
          <button className="button secondary" onClick={() => buildingsQuery.refetch()}>
            Try again
          </button>
        </section>
      )}
      {(showForm || editing) && buildingsQuery.isPending && (
        <section className="state-panel">
          <span className="spinner" />
          Loading buildings…
        </section>
      )}
      {(showForm || editing) && buildingsQuery.data && buildings.length === 0 && (
        <section className="state-panel">
          <h2>Add a building and flat first</h2>
          <p>Residents must be linked to a flat in this society.</p>
        </section>
      )}
      {(showForm || editing) && buildings.length > 0 && (
        <ResidentForm
          key={editing?.id ?? 'new-resident'}
          society={society}
          initial={editing}
          buildings={buildings}
          csrfToken={csrfToken}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={onSaved}
        />
      )}
      {residentsQuery.isPending && (
        <section className="state-panel">
          <span className="spinner" />
          Loading residents…
        </section>
      )}
      {residentsQuery.isError && (
        <section className="state-panel error-state">
          <h2>We couldn’t load residents</h2>
          <p>{residentsQuery.error.message}</p>
          <button className="button secondary" onClick={() => residentsQuery.refetch()}>
            Try again
          </button>
        </section>
      )}
      {residentsQuery.data && residents.length === 0 && (
        <section className="empty-panel resident-empty">
          <span className="empty-mark">R</span>
          <h2>No residents found</h2>
          <p>
            {search
              ? 'Try another search or clear the current filters.'
              : 'Add residents to a flat to keep your community directory current.'}
          </p>
          {canManage && !showForm && (
            <button className="button primary" onClick={() => setShowForm(true)}>
              Add a resident
            </button>
          )}
        </section>
      )}
      {residents.length > 0 && (
        <section className="resident-table-panel">
          <div className="table-overflow">
            <table className="flat-table resident-table">
              <caption className="sr-only">Resident directory for {society.name}</caption>
              <thead>
                <tr>
                  <th>Resident</th>
                  <th>Flat</th>
                  <th>Type</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {residents.map((resident) => (
                  <tr key={resident.id}>
                    <td>
                      <b>{resident.fullName}</b>
                      {resident.emergencyContactName && (
                        <small>Emergency: {resident.emergencyContactName}</small>
                      )}
                    </td>
                    <td>
                      {resident.flat.building.name} · {resident.flat.flatNumber}
                    </td>
                    <td>{resident.residentType === 'OWNER' ? 'Owner' : 'Tenant'}</td>
                    <td>
                      {resident.email || resident.phone || '—'}
                      {resident.email && resident.phone && <small>{resident.phone}</small>}
                    </td>
                    <td>
                      <span
                        className={`occupancy ${resident.status === 'ACTIVE' ? 'occupied' : 'vacant'}`}
                      >
                        {resident.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      {canManage && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setShowForm(false);
                            setEditing(resident);
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {residentsQuery.hasNextPage && (
            <div className="load-more">
              <button
                className="button secondary"
                disabled={residentsQuery.isFetchingNextPage}
                onClick={() => residentsQuery.fetchNextPage()}
              >
                {residentsQuery.isFetchingNextPage ? 'Loading…' : 'Load more residents'}
              </button>
            </div>
          )}
        </section>
      )}
      {buildingsQuery.hasNextPage && (showForm || editing) && (
        <button className="text-button" onClick={() => buildingsQuery.fetchNextPage()}>
          Load more buildings
        </button>
      )}
    </div>
  );
}
