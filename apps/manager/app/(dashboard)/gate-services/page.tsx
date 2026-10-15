'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GateServiceFilters, type GateServiceKind, type StaffGateService } from '@/lib/queries';

const VIEWS = ['open', 'accepted', 'in_progress', 'closed', 'all'] as const;
type View = (typeof VIEWS)[number];
const KINDS: (GateServiceKind | '')[] = ['', 'accessibility', 'suspicious', 'escort', 'lane'];
const MINUTES = [2, 5, 10, 15] as const;

/** One line of what was asked. */
function asked(r: StaffGateService): string {
  switch (r.kind) {
    case 'accessibility':
      return `${humanize(r.assistanceKind ?? '')}${r.member ? ` for ${r.member.firstName ?? 'a member'}` : ''}, from ${r.fromPlace?.nameEn ?? '—'} to ${r.toPlace?.nameEn ?? 'the unit'}`;
    case 'escort':
      return `From ${r.fromPlace?.nameEn ?? '—'} to ${r.toPlace?.nameEn ?? '—'}`;
    case 'suspicious':
      return `At ${r.place?.nameEn ?? '—'}`;
    case 'lane':
      return `${humanize(r.laneReason ?? '')} at ${r.gate?.name ?? '—'}`;
  }
}

function ServiceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const request = useQuery({ queryKey: keys.gateService(id), queryFn: () => fetchers.gateService(id) });
  const [step, setStep] = useState<'accept' | 'close' | null>(null);
  const [minutes, setMinutes] = useState<(typeof MINUTES)[number] | ''>('');
  const [note, setNote] = useState('');
  const accept = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/gate/gate-services/{id}/accept', {
          params: { path: { id } },
          body: minutes === '' ? {} : { etaMinutes: minutes },
        }),
      ),
    {
      invalidate: [keys.gateServicesAll],
      onDone: () => {
        toast.show('Accepted. The resident is told.');
        setStep(null);
      },
    },
  );
  const start = useAction(() => unwrap(api.POST('/api/v1/gate/gate-services/{id}/start', { params: { path: { id } } })), {
    invalidate: [keys.gateServicesAll],
    onDone: () => toast.show('Started.'),
  });
  const close = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/gate/gate-services/{id}/close', {
          params: { path: { id } },
          body: { reasonCode, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.gateServicesAll],
      onDone: () => {
        toast.show('Closed. The resident is told.');
        setStep(null);
      },
    },
  );
  const r = request.data;
  const live = r ? ['open', 'accepted', 'in_progress'].includes(r.status) : false;
  return (
    <>
      <Dialog
        open={step === null}
        wide
        onClose={onClose}
        title={r ? `${r.reference} · ${humanize(r.kind)}` : 'Request'}
        description={r ? asked(r) : undefined}
        footer={
          <>
            {r?.status === 'open' ? (
              <Button variant="primary" onClick={() => setStep('accept')}>
                Accept
              </Button>
            ) : null}
            {r?.status === 'accepted' && r.isMine ? (
              <Button loading={start.isPending} onClick={() => start.mutate(undefined)}>
                Start
              </Button>
            ) : null}
            {live ? <Button onClick={() => setStep('close')}>Close</Button> : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={request} rows={5}>
          {r ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.closeReason ? <span className="t-secondary"> · {humanize(r.closeReason)}</span> : null}
                </dd>
                <dt>Asked by</dt>
                <dd>
                  {r.requestedBy.erased ? 'An erased account' : r.requestedBy.firstName} · {r.location.unitCode} ·{' '}
                  {formatDateTime(r.createdAt)}
                </dd>
                {r.wantedAt ? (
                  <>
                    <dt>Wanted</dt>
                    <dd>{formatDateTime(r.wantedAt)}</dd>
                  </>
                ) : null}
                <dt>Handled by</dt>
                <dd>
                  {r.handledBy ? `${r.handledBy.firstName ?? '—'}${r.minutesAway !== null ? ` · ${r.minutesAway} min away` : ''}` : 'Nobody yet'}
                </dd>
                {r.description ? (
                  <>
                    <dt>What they saw</dt>
                    <dd>{r.description}</dd>
                  </>
                ) : null}
                {r.notes ? (
                  <>
                    <dt>Notes</dt>
                    <dd>{r.notes}</dd>
                  </>
                ) : null}
                {r.closeNote ? (
                  <>
                    <dt>Our note</dt>
                    <dd>{r.closeNote}</dd>
                  </>
                ) : null}
              </dl>
              {r.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={r.photoUrl} target="_blank" rel="noreferrer">
                  Open the photo
                </a>
              ) : null}
              <ErrorAlert error={start.error} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <Dialog
        open={step === 'accept'}
        onClose={() => setStep(null)}
        title={`Accept ${r?.reference ?? ''}`}
        description="The resident sees your first name and, for help that comes to them, the minutes counting down."
        onSubmit={() => accept.mutate(undefined)}
        footer={
          <>
            <Button onClick={() => setStep(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={accept.isPending}>
              Accept
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Minutes away" hint="Required for accessibility help and an escort.">
            {(p) => (
              <Select
                {...p}
                value={String(minutes)}
                onChange={(ev) => setMinutes(ev.target.value ? (Number(ev.target.value) as (typeof MINUTES)[number]) : '')}
              >
                <option value="">None</option>
                {MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={accept.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={step === 'close'}
        onClose={() => setStep(null)}
        title={`Close ${r?.reference ?? ''}?`}
        description="The resident sees it closed and why, never your note."
        codes={REASON_CODES.gateServiceClose}
        confirmLabel="Close"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => close.mutate(reasonCode)}
      >
        <Field label="Note (optional)" hint="For the management: up to 500 characters.">
          {(p) => <Textarea {...p} value={note} onChange={(ev) => setNote(ev.target.value)} />}
        </Field>
      </ReasonCodeDialog>
    </>
  );
}

/**
 * What residents ask security for (ADR 0047): accessibility help,
 * suspicious-activity reports, escorts and lanes. The open ones oldest
 * first, refreshed every thirty seconds. Never a resident's phone.
 */
export default function GateServicesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('gate_services.handle');
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<GateServiceKind | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const filters: GateServiceFilters = { status: view === 'all' ? '' : view, kind };
  const list = useCursorList(keys.gateServices(filters), (c) => fetchers.gateServices(filters, c), {
    enabled: allowed,
    refetchInterval: 30_000,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Gate services" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Gate services" description="Oldest first. Guards accept from the app; you can accept, start and close here." />
      <div className="toolbar">
        <Segmented<View>
          label="Requests shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'closed', label: 'Closed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as GateServiceKind | '')}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k ? humanize(k) : 'All kinds'}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffGateService>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={view === 'open' ? 'No request waits' : 'No request matches'}
            columns={[
              {
                key: 'ref',
                header: 'Request',
                cell: (r) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(r.id)}>
                    {r.reference}
                  </Button>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (r) => humanize(r.kind) },
              { key: 'what', header: 'What', cell: (r) => asked(r) },
              { key: 'unit', header: 'Unit', cell: (r) => r.location.unitCode },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'when', header: 'Asked', cell: (r) => <span title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ServiceDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
