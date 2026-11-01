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
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Something went wrong. Please try again.');
  }
  return payload;
}

function Input({
  label,
  name,
  value,
  onChange,
  type = 'text',
  required = false,
  min,
  max,
  maxLength,
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b aria-hidden="true"> *</b>}
      </span>
      <input
        name={name}
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        min={min}
        max={max}
        maxLength={maxLength}
        autoComplete="off"
      />
    </label>
  );
}

function BuildingForm({ initial, onSave, onCancel, saving, error }) {
  const [name, setName] = useState(initial?.name ?? '');
  return (
    <form
      className="inline-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ name });
      }}
    >
      <div className="form-grid single-column">
        <Input
          label="Building name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
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
          {saving ? 'Saving…' : initial ? 'Save name' : 'Add building'}
        </button>
      </div>
    </form>
  );
}

function FlatForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    flatNumber: initial?.flatNumber ?? '',
    floor: initial?.floor ?? 0,
    flatType: initial?.flatType ?? '',
    occupancyStatus: initial?.occupancyStatus ?? 'VACANT',
  });
  const change = (event) => setForm({ ...form, [event.target.name]: event.target.value });
  return (
    <form
      className="inline-editor flat-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...form, floor: Number(form.floor) });
      }}
    >
      <div className="form-grid">
        <Input
          label="Flat number"
          name="flatNumber"
          value={form.flatNumber}
          onChange={change}
          required
          maxLength={20}
        />
        <Input
          label="Floor"
          name="floor"
          value={form.floor}
          onChange={change}
          type="number"
          min={-5}
          max={200}
          required
        />
        <Input
          label="Flat type (optional)"
          name="flatType"
          value={form.flatType}
          onChange={change}
          maxLength={40}
        />
        <label className="field">
          <span>Occupancy</span>
          <select name="occupancyStatus" value={form.occupancyStatus} onChange={change}>
            <option value="VACANT">Vacant</option>
            <option value="OCCUPIED">Occupied</option>
          </select>
        </label>
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
          {saving ? 'Saving…' : initial ? 'Save flat' : 'Add flat'}
        </button>
      </div>
    </form>
  );
}

export default function BuildingsPage({ society, csrfToken, canManage }) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState(null);
  const [showBuildingForm, setShowBuildingForm] = useState(false);
  const [editingBuilding, setEditingBuilding] = useState(false);
  const [showFlatForm, setShowFlatForm] = useState(false);
  const [editingFlat, setEditingFlat] = useState(null);
  const root = `/societies/${society.id}/buildings`;
  const buildingsQuery = useInfiniteQuery({
    queryKey: ['buildings', society.id],
    initialPageParam: null,
    queryFn: ({ pageParam }) => api(`${root}${pageParam ? `?cursor=${pageParam}` : ''}`),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const buildings = buildingsQuery.data?.pages.flatMap((page) => page.buildings) ?? [];
  const summary = buildingsQuery.data?.pages.at(-1)?.summary ?? {
    buildingCount: 0,
    flatCount: 0,
    occupiedCount: 0,
    vacantCount: 0,
  };
  const activeBuilding = buildings.find((building) => building.id === activeId) ?? buildings[0];
  const flatPath = activeBuilding ? `${root}/${activeBuilding.id}/flats` : null;
  const flatsQuery = useInfiniteQuery({
    queryKey: ['flats', society.id, activeBuilding?.id],
    initialPageParam: null,
    queryFn: ({ pageParam }) => api(`${flatPath}${pageParam ? `?cursor=${pageParam}` : ''}`),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(flatPath),
  });
  const flats = flatsQuery.data?.pages.flatMap((page) => page.flats) ?? [];
  const refreshBuildings = () =>
    queryClient.invalidateQueries({ queryKey: ['buildings', society.id] });
  const refreshFlats = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['flats', society.id] }),
      refreshBuildings(),
    ]);
  };

  const createBuilding = useMutation({
    mutationFn: (body) => api(root, { method: 'POST', body, csrfToken }),
    onSuccess: async ({ building }) => {
      setActiveId(building.id);
      setShowBuildingForm(false);
      await refreshBuildings();
    },
  });
  const renameBuilding = useMutation({
    mutationFn: (body) => api(`${root}/${activeBuilding.id}`, { method: 'PATCH', body, csrfToken }),
    onSuccess: async () => {
      setEditingBuilding(false);
      await refreshBuildings();
    },
  });
  const createFlat = useMutation({
    mutationFn: (body) => api(flatPath, { method: 'POST', body, csrfToken }),
    onSuccess: async () => {
      setShowFlatForm(false);
      await refreshFlats();
    },
  });
  const updateFlat = useMutation({
    mutationFn: ({ flatId, ...body }) =>
      api(`${flatPath}/${flatId}`, { method: 'PATCH', body, csrfToken }),
    onSuccess: async () => {
      setEditingFlat(null);
      await refreshFlats();
    },
  });

  if (buildingsQuery.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading buildings and flats…
      </section>
    );
  if (buildingsQuery.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load buildings</h2>
        <p>{buildingsQuery.error.message}</p>
        <button className="button secondary" onClick={() => buildingsQuery.refetch()}>
          Try again
        </button>
      </section>
    );

  return (
    <div className="buildings-page">
      <section className="data-summary" aria-label="Building and flat totals">
        <div>
          <span>Buildings</span>
          <b>{summary.buildingCount}</b>
        </div>
        <div>
          <span>Total flats</span>
          <b>{summary.flatCount}</b>
        </div>
        <div>
          <span>Occupied</span>
          <b>{summary.occupiedCount}</b>
        </div>
        <div>
          <span>Vacant</span>
          <b>{summary.vacantCount}</b>
        </div>
      </section>

      {showBuildingForm && (
        <BuildingForm
          onSave={(body) => createBuilding.mutate(body)}
          onCancel={() => setShowBuildingForm(false)}
          saving={createBuilding.isPending}
          error={createBuilding.error?.message}
        />
      )}

      {!buildings.length && !showBuildingForm && (
        <section className="empty-panel">
          <span className="empty-mark">B</span>
          <h2>Start with your first building</h2>
          <p>
            Add buildings or blocks, then register each flat. Occupancy totals will update from the
            records you add.
          </p>
          {canManage ? (
            <button className="button primary" onClick={() => setShowBuildingForm(true)}>
              Add a building
            </button>
          ) : (
            <p>Ask a society administrator to add the first building.</p>
          )}
        </section>
      )}

      {buildings.length > 0 && (
        <div className="building-layout">
          <section className="building-list-panel">
            <div className="panel-title-row">
              <div>
                <h2>Buildings</h2>
                <p>{society.name}</p>
              </div>
              {canManage && (
                <button
                  className="button primary compact"
                  onClick={() => setShowBuildingForm((shown) => !shown)}
                >
                  + Add
                </button>
              )}
            </div>
            <div className="building-list">
              {buildings.map((building) => (
                <button
                  key={building.id}
                  className={`building-choice${activeBuilding?.id === building.id ? ' selected' : ''}`}
                  onClick={() => {
                    setActiveId(building.id);
                    setShowFlatForm(false);
                    setEditingFlat(null);
                    setEditingBuilding(false);
                  }}
                >
                  <span className="building-avatar">{building.name.slice(0, 1).toUpperCase()}</span>
                  <span className="building-choice-copy">
                    <b>{building.name}</b>
                    <small>
                      {building.flatCount} {building.flatCount === 1 ? 'flat' : 'flats'}
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </section>

          <section className="flat-panel">
            {editingBuilding ? (
              <BuildingForm
                initial={activeBuilding}
                onSave={(body) => renameBuilding.mutate(body)}
                onCancel={() => setEditingBuilding(false)}
                saving={renameBuilding.isPending}
                error={renameBuilding.error?.message}
              />
            ) : (
              <header className="panel-title-row flat-panel-header">
                <div>
                  <p className="eyebrow">BUILDING</p>
                  <h2>{activeBuilding.name}</h2>
                  <p>
                    {activeBuilding.flatCount} registered{' '}
                    {activeBuilding.flatCount === 1 ? 'flat' : 'flats'}
                  </p>
                </div>
                {canManage && (
                  <div className="form-actions">
                    <button className="button secondary" onClick={() => setEditingBuilding(true)}>
                      Rename
                    </button>
                    <button
                      className="button primary"
                      onClick={() => {
                        setShowFlatForm((shown) => !shown);
                        setEditingFlat(null);
                      }}
                    >
                      + Add flat
                    </button>
                  </div>
                )}
              </header>
            )}

            {showFlatForm && (
              <FlatForm
                onSave={(body) => createFlat.mutate(body)}
                onCancel={() => setShowFlatForm(false)}
                saving={createFlat.isPending}
                error={createFlat.error?.message}
              />
            )}
            {editingFlat && (
              <FlatForm
                key={editingFlat.id}
                initial={editingFlat}
                onSave={(body) => updateFlat.mutate({ flatId: editingFlat.id, ...body })}
                onCancel={() => setEditingFlat(null)}
                saving={updateFlat.isPending}
                error={updateFlat.error?.message}
              />
            )}

            {flatsQuery.isPending && (
              <div className="inline-state">
                <span className="spinner" />
                Loading flats…
              </div>
            )}
            {flatsQuery.isError && (
              <div className="inline-state error-state">
                <p>{flatsQuery.error.message}</p>
                <button className="button secondary" onClick={() => flatsQuery.refetch()}>
                  Try again
                </button>
              </div>
            )}
            {flatsQuery.data && flats.length === 0 && !showFlatForm && (
              <div className="empty-flats">
                <h3>No flats in this building yet</h3>
                <p>Add each flat to keep your community layout up to date.</p>
                {canManage && (
                  <button className="button secondary" onClick={() => setShowFlatForm(true)}>
                    Add the first flat
                  </button>
                )}
              </div>
            )}
            {flats.length > 0 && (
              <div className="flat-table-wrap">
                <table className="flat-table">
                  <caption className="sr-only">Flats in {activeBuilding.name}</caption>
                  <thead>
                    <tr>
                      <th>Flat</th>
                      <th>Floor</th>
                      <th>Type</th>
                      <th>Occupancy</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {flats.map((flat) => (
                      <tr key={flat.id}>
                        <td>
                          <b>{flat.flatNumber}</b>
                        </td>
                        <td>{flat.floor}</td>
                        <td>{flat.flatType || '—'}</td>
                        <td>
                          <span className={`occupancy ${flat.occupancyStatus.toLowerCase()}`}>
                            {flat.occupancyStatus === 'OCCUPIED' ? 'Occupied' : 'Vacant'}
                          </span>
                        </td>
                        <td>
                          {canManage && (
                            <button
                              className="text-button"
                              onClick={() => {
                                setShowFlatForm(false);
                                setEditingFlat(flat);
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
            )}
            {flatsQuery.hasNextPage && (
              <div className="load-more">
                <button
                  className="button secondary"
                  disabled={flatsQuery.isFetchingNextPage}
                  onClick={() => flatsQuery.fetchNextPage()}
                >
                  {flatsQuery.isFetchingNextPage ? 'Loading…' : 'Load more flats'}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {buildingsQuery.hasNextPage && (
        <div className="load-more building-load-more">
          <button
            className="button secondary"
            disabled={buildingsQuery.isFetchingNextPage}
            onClick={() => buildingsQuery.fetchNextPage()}
          >
            {buildingsQuery.isFetchingNextPage ? 'Loading…' : 'Load more buildings'}
          </button>
        </div>
      )}
    </div>
  );
}
