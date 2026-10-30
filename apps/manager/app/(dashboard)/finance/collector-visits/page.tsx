'use client';

import { fieldError, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Visit = Schema<'CollectorVisitView'>;
type Filter = 'open' | Visit['status'];
const KEY = ['finance', 'collector-visits'] as const;
const SETTINGS = ['finance', 'collector-settings'] as const;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'collected', label: 'Collected' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Called off' },
];
const label = (code: string) => code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
const windowText = (v: Visit) => `${formatDateTime(v.windowStartsAt)} – ${new Date(v.windowEndsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

function Assign({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const toast = useToast();
  const collectors = useQuery({ queryKey: ['finance', 'collectors'], queryFn: () => unwrap(api.GET('/api/v1/staff/collectors')) });
  const [collectorId, setCollectorId] = useState('');
  const assign = useAction(
    () => unwrap(api.POST('/api/v1/staff/collector-visits/{id}/assign', { params: { path: { id: visit.id } }, body: { collectorId } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Assigned: the collector and the resident are told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Collector for ${visit.unitCode}`}
      description={windowText(visit)}
      onSubmit={() => collectorId && assign.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={assign.isPending} disabled={!collectorId}>
            Assign
          </Button>
        </>
      }
    >
      <QueryState query={collectors}>
        <div className="form">
          <Field label="Collector" hint="Staff whose role holds collector visits." error={fieldError(assign.error, 'collectorId')}>
            {(p) => (
              <Select {...p} value={collectorId} onChange={(e) => setCollectorId(e.target.value)}>
                <option value="">Choose…</option>
                {collectors.data?.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName ?? c.id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={assign.error} />
        </div>
      </QueryState>
    </Dialog>
  );
}

function CallOff({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const cancel = useAction(
    () => unwrap(api.POST('/api/v1/staff/collector-visits/{id}/cancel', { params: { path: { id: visit.id } }, body: { reasonCode: code } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Called off.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Call off the visit to ${visit.unitCode}`}
      onSubmit={() => code && cancel.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button type="submit" variant="danger" loading={cancel.isPending} disabled={!code}>
            Call off
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Why" error={fieldError(cancel.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose…</option>
              {REASON_CODES.collectorVisitCancel.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={cancel.error} />
      </div>
    </Dialog>
  );
}

/** What a collector may take above what a unit owes (ADR 0069). */
function Margin() {
  const toast = useToast();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => unwrap(api.GET('/api/v1/staff/finance/collector-settings')) });
  const [margin, setMargin] = useState('');
  useEffect(() => {
    if (settings.data) setMargin(settings.data.collectorMargin);
  }, [settings.data]);
  const save = useAction(() => unwrap(api.PATCH('/api/v1/staff/finance/collector-settings', { body: { collectorMargin: margin.trim() } })), {
    invalidate: [SETTINGS],
    onDone: () => toast.show('Margin saved.'),
  });
  const valid = /^\d{1,4}(\.\d{1,2})?$/.test(margin.trim()) && Number(margin) <= 1000;
  return (
    <Card>
      <CardHeader title="Collector’s margin" />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field
              label="Above what a unit owes, EGP"
              hint="A round sum may go a little over; more than this is refused, so a mistyped figure never makes a large credit. 0 to 1000."
              error={fieldError(save.error, 'collectorMargin')}
            >
              {(p) => <Input {...p} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />}
            </Field>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
                Save
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/**
 * Collector visits (ADR 0069): residents ask for a collector in a window;
 * the staff who keep payments give each to a collector, who records the
 * cash taken — an office payment with its receipt — or why it failed.
 */
export default function CollectorVisitsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.payments');
  const [filter, setFilter] = useState<Filter>('open');
  const list = useQuery({
    queryKey: [...KEY, filter],
    queryFn: () => unwrap(api.GET('/api/v1/staff/collector-visits', { params: { query: filter === 'open' ? {} : { status: filter } } })),
    enabled: allowed,
  });
  const [assigning, setAssigning] = useState<Visit | null>(null);
  const [cancelling, setCancelling] = useState<Visit | null>(null);
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Collector visits" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Collector visits" description="Cash taken at the units by field collectors, on the residents’ request." />
      <div className="stack">
        <Segmented label="Status" value={filter} onChange={setFilter} options={FILTERS} />
        <Card flush>
          <QueryState query={list}>
            <DataTable<Visit>
              rows={list.data?.data}
              rowKey={(v) => v.id}
              empty="None"
              columns={[
                { key: 'u', header: 'Unit', cell: (v) => <span className="t-mono">{v.unitCode}</span> },
                { key: 'b', header: 'Building', cell: (v) => v.building ?? '—' },
                { key: 'w', header: 'Window', cell: (v) => windowText(v) },
                { key: 'e', header: 'Expected', cell: (v) => (v.expectedAmount ? `${v.expectedAmount} EGP` : '—') },
                {
                  key: 's',
                  header: 'Status',
                  cell: (v) => <Badge tone={v.status === 'collected' ? 'green' : v.status === 'failed' ? 'error' : 'beige'}>{label(v.status)}</Badge>,
                },
                { key: 'r', header: 'Why', cell: (v) => (v.failReason ? label(v.failReason) : v.cancelReason ? label(v.cancelReason) : '—') },
                {
                  key: 'a',
                  header: '',
                  className: 'table__actions',
                  cell: (v) =>
                    v.status === 'requested' || v.status === 'assigned' ? (
                      <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="primary" onClick={() => setAssigning(v)}>
                          {v.assigned ? 'Reassign' : 'Assign'}
                        </Button>
                        <Button size="sm" onClick={() => setCancelling(v)}>
                          Call off
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
        <Margin />
      </div>
      {assigning ? <Assign visit={assigning} onClose={() => setAssigning(null)} /> : null}
      {cancelling ? <CallOff visit={cancelling} onClose={() => setCancelling(null)} /> : null}
    </>
  );
}
