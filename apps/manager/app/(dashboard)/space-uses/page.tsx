'use client';

import { humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { slotText } from '@/components/management-requests/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SpaceUse, type SpaceUseArea, type SpaceUseStatus } from '@/lib/queries';

const STATUSES: (SpaceUseStatus | '')[] = ['pending', 'approved', 'refused', 'cancelled', 'expired', ''];

/** The common areas open to requests (`spaces.manage`). */
function OpenAreas() {
  const toast = useToast();
  const open = useQuery({ queryKey: keys.spaceUseAreas, queryFn: fetchers.spaceUseAreas });
  const areas = useQuery({
    queryKey: keys.areas({ active: 'true' }),
    queryFn: () => fetchers.areas({ active: 'true' }),
  });
  const [picked, setPicked] = useState('');
  const change = useAction(
    (input: { id: string; open: boolean }) =>
      input.open
        ? unwrap(api.PUT('/api/v1/staff/space-use-areas/{commonAreaId}', { params: { path: { commonAreaId: input.id } } }))
        : unwrap(api.DELETE('/api/v1/staff/space-use-areas/{commonAreaId}', { params: { path: { commonAreaId: input.id } } })),
    {
      invalidate: [keys.spaceUseAreas],
      onDone: (_r, v) => {
        toast.show(v.open ? 'Residents may ask for it now.' : 'It takes no new requests; what was asked stands.');
        setPicked('');
      },
    },
  );
  const openIds = new Set((open.data?.data ?? []).map((a) => a.commonAreaId));
  const candidates = (areas.data?.data ?? []).filter((a) => a.kind !== 'building' && !openIds.has(a.id));
  return (
    <Card>
      <div className="stack">
        <h3>Areas residents may ask for</h3>
        <div className="row" style={{ gap: 8 }}>
          <Select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Common area to open">
            <option value="">Open a common area…</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.nameEn}
              </option>
            ))}
          </Select>
          <Button disabled={!picked} loading={change.isPending} onClick={() => change.mutate({ id: picked, open: true })}>
            Open
          </Button>
        </div>
        <QueryState query={open}>
          <DataTable<SpaceUseArea>
            rows={open.data?.data ?? []}
            rowKey={(a) => a.commonAreaId}
            empty="No area is open to requests"
            columns={[
              { key: 'area', header: 'Area', cell: (a) => `${a.code} · ${a.nameEn}` },
              { key: 'facility', header: '', cell: (a) => (a.facilityId ? <Badge tone="beige">A facility: closed to bookings while in use</Badge> : null) },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (a) => (
                  <Button size="sm" onClick={() => change.mutate({ id: a.commonAreaId, open: false })}>
                    Close
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={change.error} />
      </div>
    </Card>
  );
}

/**
 * Residents' requests to use a common area (ADR 0084): approve, refuse with
 * a reason, or cancel an approved one. An approval is refused when another
 * approved use overlaps, or the facility is booked or closed then.
 */
export default function SpaceUsesPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const handles = can('bookings.handle');
  const keeps = can('spaces.manage');
  const [status, setStatus] = useState<SpaceUseStatus | ''>('pending');
  const [refusing, setRefusing] = useState<SpaceUse | null>(null);
  const [cancelling, setCancelling] = useState<SpaceUse | null>(null);
  const list = useCursorList(keys.spaceUses(status), (c) => fetchers.spaceUses(status, c), { enabled: handles });
  const decide = useAction(
    (input: { id: string; action: 'approve' | 'refuse' | 'cancel'; reasonCode?: string }) =>
      input.action === 'approve'
        ? unwrap(api.POST('/api/v1/staff/space-uses/{id}/approve', { params: { path: { id: input.id } } }))
        : input.action === 'refuse'
          ? unwrap(
              api.POST('/api/v1/staff/space-uses/{id}/refuse', {
                params: { path: { id: input.id } },
                body: { reasonCode: input.reasonCode! },
              }),
            )
          : unwrap(
              api.POST('/api/v1/staff/space-uses/{id}/cancel', {
                params: { path: { id: input.id } },
                body: { reasonCode: input.reasonCode! },
              }),
            ),
    {
      invalidate: [keys.spacesAll],
      onDone: (_r, v) => {
        toast.show(v.action === 'approve' ? 'Approved; the requester is told.' : v.action === 'refuse' ? 'Refused; the requester is told.' : 'Cancelled; the requester is told.');
        setRefusing(null);
        setCancelling(null);
      },
    },
  );
  if (ready && !handles && !keeps)
    return (
      <>
        <PageHeader title="Common-area uses" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Common-area uses" description="Residents ask to use a common area for a time; the staff decide." />
      {keeps ? <OpenAreas /> : null}
      {handles ? (
        <>
          <div className="toolbar">
            <Select value={status} onChange={(e) => setStatus(e.target.value as SpaceUseStatus | '')} aria-label="Status">
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? humanize(s) : 'All'}
                </option>
              ))}
            </Select>
          </div>
          <Card flush>
            <QueryState query={list}>
              <DataTable<SpaceUse>
                rows={list.rows}
                rowKey={(u) => u.id}
                empty="No request"
                columns={[
                  { key: 'when', header: 'When', cell: (u) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(u.startsAt, u.endsAt)}</span> },
                  { key: 'area', header: 'Area', cell: (u) => `${u.areaCode} · ${u.areaNameEn}` },
                  { key: 'unit', header: 'Unit', cell: (u) => u.unitCode },
                  { key: 'purpose', header: 'Purpose', cell: (u) => u.purpose ?? '—' },
                  { key: 'guests', header: 'Guests', cell: (u) => u.guests },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (u) => (
                      <Badge tone={u.status === 'approved' ? 'terracotta' : 'beige'}>
                        {humanize(u.status)}
                        {u.reasonCode ? ` · ${humanize(u.reasonCode)}` : ''}
                      </Badge>
                    ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'table__actions',
                    cell: (u) =>
                      u.status === 'pending' ? (
                        <>
                          <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ id: u.id, action: 'approve' })}>
                            Approve
                          </Button>
                          <Button size="sm" onClick={() => setRefusing(u)}>
                            Refuse
                          </Button>
                        </>
                      ) : u.status === 'approved' && new Date(u.endsAt) > new Date() ? (
                        <Button size="sm" onClick={() => setCancelling(u)}>
                          Cancel
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <LoadMore query={list} />
            </QueryState>
          </Card>
          <ErrorAlert error={refusing || cancelling ? null : decide.error} />
        </>
      ) : null}
      <ReasonCodeDialog
        open={refusing !== null}
        onClose={() => setRefusing(null)}
        title="Refuse the request?"
        description="The requester is told, with the reason."
        codes={REASON_CODES.spaceUseRefuse}
        confirmLabel="Refuse"
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => refusing && decide.mutate({ id: refusing.id, action: 'refuse', reasonCode })}
      />
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel the approved use?"
        description="The requester is told, with the reason."
        codes={REASON_CODES.spaceUseCancel}
        confirmLabel="Cancel the use"
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => cancelling && decide.mutate({ id: cancelling.id, action: 'cancel', reasonCode })}
      />
    </>
  );
}
