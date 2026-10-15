'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, DataTable, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { addDays, peakUse } from '@/components/vehicles/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffVisitorParking } from '@/lib/queries';

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const today = () => new Date().toLocaleDateString('en-CA');

/**
 * A day of visitor parking (ADR 0045): every booking touching the local
 * day, with its unit, its visitor and who booked it, and each area's peak
 * use against its spaces. The staff cancel a booking with a reason code.
 */
export default function VisitorParkingPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('vehicles.manage');
  const [day, setDay] = useState(today());
  const [areaId, setAreaId] = useState('');
  const [cancelling, setCancelling] = useState<StaffVisitorParking | null>(null);
  const areas = useQuery({ queryKey: keys.visitorAreas, queryFn: fetchers.visitorAreas, enabled: allowed });
  const bookings = useQuery({
    queryKey: keys.visitorParking(areaId, day),
    queryFn: () => fetchers.visitorParking(areaId, day),
    enabled: allowed,
    refetchInterval: 60_000,
  });
  const cancel = useAction(
    (input: { id: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/visitor-parking-bookings/{id}/cancel', {
          params: { path: { id: input.id } },
          body: { reasonCode: input.reasonCode },
        }),
      ),
    {
      invalidate: [keys.visitorParkingAll],
      onDone: () => {
        toast.show('Cancelled.');
        setCancelling(null);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Visitor parking" />
        <ForbiddenState />
      </>
    );
  const rows = bookings.data?.data ?? [];
  const from = new Date(`${day}T00:00:00`).toISOString();
  const to = new Date(`${addDays(day, 1)}T00:00:00`).toISOString();
  const peaks = (areas.data?.data ?? [])
    .filter((a) => !areaId || a.id === areaId)
    .map((a) => ({
      area: a,
      peak: peakUse(
        rows.filter((b) => b.areaId === a.id && b.status === 'confirmed'),
        from,
        to,
      ),
    }));
  return (
    <>
      <PageHeader title="Visitor parking" description="Residents’ bookings for their visitors. The guard sees what holds now and the next two hours." />
      <div className="toolbar">
        <Field label="Day">{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <Field label="Area">
          {(p) => (
            <Select {...p} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">Every area</option>
              {(areas.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {peaks.length ? (
        <Card>
          <CardBody>
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {peaks.map(({ area, peak }) => (
                <Badge key={area.id} tone={peak > area.capacity ? 'error' : peak === area.capacity ? 'terracotta' : 'green'}>
                  {area.name}: at most {peak} of {area.capacity}
                </Badge>
              ))}
            </span>
          </CardBody>
        </Card>
      ) : null}
      <Card flush>
        <QueryState query={bookings}>
          <DataTable<StaffVisitorParking>
            rows={rows}
            rowKey={(b) => b.id}
            empty="No visitor parking that day"
            columns={[
              { key: 'ref', header: 'Booking', cell: (b) => <span className="t-mono">{b.reference}</span> },
              { key: 'when', header: 'When', cell: (b) => `${time.format(new Date(b.startsAt))}–${time.format(new Date(b.endsAt))}` },
              { key: 'area', header: 'Area', cell: (b) => b.areaName },
              { key: 'unit', header: 'Unit', cell: (b) => <span className="t-mono">{b.unitCode}</span> },
              {
                key: 'visitor',
                header: 'Visitor',
                cell: (b) => (b.visitorPassId ? <Badge plain>Visitor pass</Badge> : (b.visitorName ?? <span className="t-secondary">—</span>)),
              },
              { key: 'by', header: 'Booked by', cell: (b) => (b.bookedBy.erased ? 'An erased account' : b.bookedBy.fullName) },
              {
                key: 'status',
                header: 'Status',
                cell: (b) => (
                  <span title={b.cancelReason ? humanize(b.cancelReason) : formatDateTime(b.createdAt)}>
                    <StatusBadge status={b.status} />
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (b) =>
                  b.status === 'confirmed' && new Date(b.endsAt) > new Date() ? (
                    <Button size="sm" onClick={() => setCancelling(b)}>
                      Cancel
                    </Button>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={`Cancel ${cancelling?.reference ?? ''}?`}
        description="The space is free again. The household sees it cancelled."
        codes={REASON_CODES.visitorParkingStaffCancel}
        confirmLabel="Cancel booking"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancelling && cancel.mutate({ id: cancelling.id, reasonCode })}
      />
    </>
  );
}
