'use client';

import { humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { MODE_TEXT, personName, slotText } from '@/components/management-requests/bits';
import { AppointmentActions } from '@/components/management-requests/request-appointment';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AppointmentFilters, type AppointmentItem, type AppointmentStatus } from '@/lib/queries';

const VIEWS = ['upcoming', 'to_confirm', 'all'] as const;
type View = (typeof VIEWS)[number];
const STATUSES: AppointmentStatus[] = ['requested', 'proposed', 'confirmed', 'cancelled', 'superseded'];

/**
 * The compound's appointments with the management (ADR 0039), soonest
 * first. "To confirm" are the slots residents picked and nobody has
 * answered; a slot is confirmed, countered or cancelled from its row.
 */
export default function AppointmentsPage() {
  const { can, ready } = usePermissions();
  const [view, setView] = useState<View>('upcoming');
  const [status, setStatus] = useState<AppointmentStatus | ''>('');
  // "From now" is fixed when the page opens, so paging does not shift under it.
  const [since] = useState(() => new Date().toISOString());
  const allowed = can('requests.handle');

  const filters: AppointmentFilters = {
    status: view === 'to_confirm' ? 'requested' : status,
    // An agenda shows what holds a slot, unless a status was asked for.
    live: view === 'upcoming' && !status ? 'true' : '',
    from: view === 'all' ? '' : since,
  };
  const list = useCursorList(keys.appointments(filters), (c) => fetchers.appointments(filters, c), {
    refetchInterval: 60_000,
    enabled: allowed,
  });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title="Appointments"
        description="Meetings residents booked with the management, from the office hours. Confirming or proposing a slot counts as the response to the request."
      />
      <div className="toolbar">
        <Segmented<View>
          label="Appointments shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'to_confirm', label: 'To confirm' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Status">
          {(p) => (
            <Select
              {...p}
              value={view === 'to_confirm' ? 'requested' : status}
              disabled={view === 'to_confirm'}
              onChange={(e) => setStatus(e.target.value as AppointmentStatus | '')}
            >
              <option value="">{view === 'upcoming' ? 'Holding a slot' : 'Any status'}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AppointmentItem>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={view === 'to_confirm' ? 'No slot is waiting for a confirmation' : 'No appointment matches'}
            emptyHint={view === 'upcoming' ? 'Residents book from the office hours set in Requests setup.' : undefined}
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (a) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(a.startsAt, a.endsAt)}</span>,
              },
              { key: 'mode', header: 'How', cell: (a) => MODE_TEXT[a.mode] },
              {
                key: 'resident',
                header: 'Resident',
                cell: (a) => (
                  <span className="stack stack--sm">
                    {personName(a.request.author)}
                    {a.request.unit ? <span className="t-secondary">Unit {a.request.unit.code}</span> : null}
                  </span>
                ),
              },
              {
                key: 'request',
                header: 'Request',
                cell: (a) => (
                  <span className="stack stack--sm">
                    <Link className="table__link t-mono" href={`/management-requests/${a.request.id}`}>
                      {a.request.number}
                    </Link>
                    <span className="t-secondary">{a.request.topic.nameEn}</span>
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (a) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={a.status} />
                    <span className="t-secondary">
                      {a.status === 'cancelled'
                        ? humanize(a.cancelReason)
                        : a.proposedBy === 'staff'
                          ? 'Picked by the management'
                          : 'Picked by the resident'}
                    </span>
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (a) =>
                  a.status === 'requested' || a.status === 'proposed' || a.status === 'confirmed' ? (
                    <AppointmentActions requestId={a.request.id} number={a.request.number} requestStatus={a.request.status} appointment={a} compact />
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
