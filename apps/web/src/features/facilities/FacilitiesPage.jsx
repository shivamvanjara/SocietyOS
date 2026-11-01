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

async function fetchBookings(path) {
  const bookings = [];
  let cursor;
  let canManage = false;
  do {
    const result = await api(`${path}?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    bookings.push(...result.bookings);
    canManage = result.canManage;
    cursor = result.nextCursor;
  } while (cursor);
  return { bookings, canManage };
}

const emptyBooking = () => ({ facilityId: '', startsAt: '', endsAt: '', purpose: '' });

export default function FacilitiesPage({ society, csrfToken, canManage }) {
  const root = `/societies/${society.id}/facilities`;
  const queryClient = useQueryClient();
  const [showFacilityForm, setShowFacilityForm] = useState(false);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [facilityForm, setFacilityForm] = useState({ name: '', description: '', capacity: '1' });
  const [bookingForm, setBookingForm] = useState(emptyBooking);
  const [error, setError] = useState('');
  const facilitiesQuery = useQuery({
    queryKey: ['facilities', society.id],
    queryFn: () => api(root),
  });
  const bookingsQuery = useQuery({
    queryKey: ['facility-bookings', society.id],
    queryFn: () => fetchBookings(`${root}/bookings`),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['facilities', society.id] }),
      queryClient.invalidateQueries({ queryKey: ['facility-bookings', society.id] }),
    ]);
  };
  const facilityMutation = useMutation({
    mutationFn: () =>
      api(root, {
        method: 'POST',
        csrfToken,
        body: {
          ...facilityForm,
          description: facilityForm.description || null,
          capacity: Number(facilityForm.capacity),
        },
      }),
    onSuccess: () => {
      setShowFacilityForm(false);
      setFacilityForm({ name: '', description: '', capacity: '1' });
      setError('');
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const bookingMutation = useMutation({
    mutationFn: () =>
      api(`${root}/bookings`, {
        method: 'POST',
        csrfToken,
        body: {
          ...bookingForm,
          startsAt: new Date(bookingForm.startsAt).toISOString(),
          endsAt: new Date(bookingForm.endsAt).toISOString(),
          purpose: bookingForm.purpose || null,
        },
      }),
    onSuccess: () => {
      setShowBookingForm(false);
      setBookingForm(emptyBooking());
      setError('');
      refresh();
    },
    onError: (cause) => setError(cause.message),
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }) =>
      api(`${root}/bookings/${id}/status`, { method: 'PATCH', csrfToken, body: { status } }),
    onSuccess: refresh,
    onError: (cause) => setError(cause.message),
  });
  const activeMutation = useMutation({
    mutationFn: ({ id, active }) =>
      api(`${root}/${id}`, { method: 'PATCH', csrfToken, body: { active } }),
    onSuccess: refresh,
    onError: (cause) => setError(cause.message),
  });
  const cancelMutation = useMutation({
    mutationFn: (id) =>
      api(`${root}/bookings/${id}/cancel`, { method: 'POST', csrfToken, body: {} }),
    onSuccess: refresh,
    onError: (cause) => setError(cause.message),
  });
  if (facilitiesQuery.isPending || bookingsQuery.isPending)
    return (
      <section className="state-panel">
        <span className="spinner" />
        Loading facilities…
      </section>
    );
  if (facilitiesQuery.isError || bookingsQuery.isError)
    return (
      <section className="state-panel error-state">
        <h2>We couldn’t load facilities</h2>
        <p>{facilitiesQuery.error?.message || bookingsQuery.error?.message}</p>
        <button
          className="button secondary"
          onClick={() => {
            facilitiesQuery.refetch();
            bookingsQuery.refetch();
          }}
        >
          Try again
        </button>
      </section>
    );
  const facilities = facilitiesQuery.data.facilities;
  const bookings = bookingsQuery.data.bookings;
  return (
    <div className="facilities-page">
      <section className="section-heading">
        <div>
          <p className="eyebrow">COMMUNITY AMENITIES</p>
          <h2>Facility bookings</h2>
          <p>Request a time, and follow approval from the society committee.</p>
        </div>
        <div className="facility-actions">
          {canManage && (
            <button
              className="button secondary"
              onClick={() => {
                setError('');
                setShowFacilityForm(!showFacilityForm);
              }}
            >
              ＋ Add facility
            </button>
          )}
          <button
            className="button primary"
            disabled={!facilities.some((facility) => facility.active)}
            onClick={() => {
              setError('');
              setBookingForm({
                ...emptyBooking(),
                facilityId: facilities.find((facility) => facility.active)?.id ?? '',
              });
              setShowBookingForm(!showBookingForm);
            }}
          >
            Request a booking
          </button>
        </div>
      </section>
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      {showFacilityForm && canManage && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            facilityMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Add a facility</h3>
              <p>Register a bookable shared space.</p>
            </div>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setShowFacilityForm(false)}
            >
              Cancel
            </button>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>
                Name <b>*</b>
              </span>
              <input
                required
                minLength={2}
                maxLength={120}
                value={facilityForm.name}
                onChange={(event) => setFacilityForm({ ...facilityForm, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>
                Capacity <b>*</b>
              </span>
              <input
                type="number"
                min="1"
                max="1000"
                step="1"
                required
                value={facilityForm.capacity}
                onChange={(event) =>
                  setFacilityForm({ ...facilityForm, capacity: event.target.value })
                }
              />
            </label>
            <label className="field facility-description">
              <span>Description</span>
              <input
                maxLength={1000}
                value={facilityForm.description}
                onChange={(event) =>
                  setFacilityForm({ ...facilityForm, description: event.target.value })
                }
              />
            </label>
          </div>
          <button className="button primary" disabled={facilityMutation.isPending}>
            {facilityMutation.isPending ? 'Saving…' : 'Save facility'}
          </button>
        </form>
      )}
      {showBookingForm && (
        <form
          className="form-card resident-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            bookingMutation.mutate();
          }}
        >
          <div className="section-heading">
            <div>
              <h3>Request a time slot</h3>
              <p>Bookings must be in the future and no longer than 12 hours.</p>
            </div>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => setShowBookingForm(false)}
            >
              Cancel
            </button>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>
                Facility <b>*</b>
              </span>
              <select
                required
                value={bookingForm.facilityId}
                onChange={(event) =>
                  setBookingForm({ ...bookingForm, facilityId: event.target.value })
                }
              >
                {facilities
                  .filter((facility) => facility.active)
                  .map((facility) => (
                    <option key={facility.id} value={facility.id}>
                      {facility.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Purpose</span>
              <input
                maxLength={300}
                value={bookingForm.purpose}
                onChange={(event) =>
                  setBookingForm({ ...bookingForm, purpose: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>
                Starts at <b>*</b>
              </span>
              <input
                type="datetime-local"
                required
                value={bookingForm.startsAt}
                onChange={(event) =>
                  setBookingForm({ ...bookingForm, startsAt: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>
                Ends at <b>*</b>
              </span>
              <input
                type="datetime-local"
                required
                value={bookingForm.endsAt}
                onChange={(event) => setBookingForm({ ...bookingForm, endsAt: event.target.value })}
              />
            </label>
          </div>
          {error && (
            <p className="form-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={bookingMutation.isPending}>
            {bookingMutation.isPending ? 'Requesting…' : 'Send booking request'}
          </button>
        </form>
      )}
      {facilities.length > 0 && (
        <section className="facility-grid">
          {facilities.map((facility) => (
            <article
              className={`facility-card${facility.active ? '' : ' inactive'}`}
              key={facility.id}
            >
              <div className="facility-card-icon">⌂</div>
              <div>
                <h3>{facility.name}</h3>
                <p>{facility.description || `${facility.capacity} person capacity`}</p>
                <small>Capacity: {facility.capacity}</small>
              </div>
              {canManage && (
                <div className="facility-admin">
                  <span className="facility-active">
                    {facility.active ? 'Available' : 'Inactive'}
                  </span>
                  <button
                    className="text-button"
                    disabled={activeMutation.isPending}
                    onClick={() =>
                      activeMutation.mutate({ id: facility.id, active: !facility.active })
                    }
                  >
                    {facility.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      {facilities.length === 0 && (
        <section className="state-panel">
          <h2>No facilities added</h2>
          <p>
            {canManage
              ? 'Add the first shared facility to accept booking requests.'
              : 'The society has not listed any bookable facilities yet.'}
          </p>
        </section>
      )}
      <section className="section-heading bookings-heading">
        <div>
          <p className="eyebrow">SCHEDULE</p>
          <h2>{canManage ? 'Booking requests' : 'Your bookings'}</h2>
        </div>
      </section>
      {bookings.length === 0 ? (
        <section className="state-panel">
          <h2>No bookings</h2>
          <p>Booking requests and their decisions will appear here.</p>
        </section>
      ) : (
        <section className="resident-table-panel">
          <div className="table-overflow">
            <table className="flat-table resident-table">
              <thead>
                <tr>
                  <th>Facility</th>
                  <th>Requested by</th>
                  <th>Time</th>
                  <th>Purpose</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => (
                  <tr key={booking.id}>
                    <td>
                      <strong>{booking.facility.name}</strong>
                    </td>
                    <td>{canManage ? booking.requester.email : 'You'}</td>
                    <td>
                      {new Date(booking.startsAt).toLocaleString()}
                      <small>Until {new Date(booking.endsAt).toLocaleString()}</small>
                    </td>
                    <td>{booking.purpose || '—'}</td>
                    <td>
                      <span
                        className={`occupancy ${booking.status === 'APPROVED' ? 'occupied' : booking.status === 'REQUESTED' ? 'vacant' : ''}`}
                      >
                        {booking.status}
                      </span>
                    </td>
                    <td>
                      {canManage && booking.status === 'REQUESTED' && (
                        <>
                          <button
                            className="text-button"
                            disabled={statusMutation.isPending}
                            onClick={() =>
                              statusMutation.mutate({ id: booking.id, status: 'APPROVED' })
                            }
                          >
                            Approve
                          </button>
                          <button
                            className="text-button"
                            disabled={statusMutation.isPending}
                            onClick={() =>
                              statusMutation.mutate({ id: booking.id, status: 'REJECTED' })
                            }
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {['REQUESTED', 'APPROVED'].includes(booking.status) &&
                        new Date(booking.startsAt) > new Date() && (
                          <button
                            className="text-button"
                            disabled={cancelMutation.isPending}
                            onClick={() => cancelMutation.mutate(booking.id)}
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
