'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
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
import { fetchers, keys, type StaffEmergency } from '@/lib/queries';

const VIEWS = ['open', 'closed'] as const;
type View = (typeof VIEWS)[number];
const MINUTES = [2, 5, 10, 15] as const;

/** Where: "Building 7 · 12". */
const where = (e: StaffEmergency) => [e.location.building, e.location.unitCode].filter(Boolean).join(' · ');

function EmergencyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const emergency = useQuery({ queryKey: keys.emergency(id), queryFn: () => fetchers.emergency(id), refetchInterval: 10_000 });
  const [step, setStep] = useState<'accept' | 'resolve' | null>(null);
  const [minutes, setMinutes] = useState<(typeof MINUTES)[number]>(5);
  const [note, setNote] = useState('');
  const accept = useAction(
    () => unwrap(api.POST('/api/v1/gate/emergencies/{id}/accept', { params: { path: { id } }, body: { etaMinutes: minutes } })),
    {
      invalidate: [keys.emergenciesAll],
      onDone: () => {
        toast.show('You are its responder. The household sees the duty phone.');
        setStep(null);
      },
    },
  );
  const resolve = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/gate/emergencies/{id}/resolve', {
          params: { path: { id } },
          body: { reasonCode, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.emergenciesAll],
      onDone: () => {
        toast.show('Resolved.');
        setStep(null);
      },
    },
  );
  const e = emergency.data;
  const open = e ? ['reported', 'on_the_way', 'arrived'].includes(e.status) : false;
  return (
    <>
      <Dialog
        open={step === null}
        wide
        onClose={onClose}
        title={e ? `${e.reference} · ${humanize(e.type)}` : 'Emergency'}
        description={e ? where(e) : undefined}
        footer={
          <>
            {open && !e?.responderAccount ? (
              <Button variant="primary" onClick={() => setStep('accept')}>
                Answer it
              </Button>
            ) : null}
            {open ? <Button onClick={() => setStep('resolve')}>Resolve</Button> : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={emergency} rows={5}>
          {e ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={e.status} />
                  {e.escalatedAt ? (
                    <>
                      {' '}
                      <Badge tone="error">{e.escalationReason === 'no_responders' ? 'Nobody to answer' : 'Not answered in time'}</Badge>
                    </>
                  ) : null}
                  {e.closeReason ? <span className="t-secondary"> · {humanize(e.closeReason)}</span> : null}
                </dd>
                <dt>Reported by</dt>
                <dd>
                  {e.reportedBy.erased ? 'An erased account' : e.reportedBy.firstName} · {formatDateTime(e.reportedAt)}
                </dd>
                <dt>Responder</dt>
                <dd>
                  {e.responderAccount
                    ? `${e.responderAccount.erased ? 'An erased account' : e.responderAccount.firstName}${
                        e.minutesAway !== null ? ` · ${e.minutesAway} min away` : ''
                      }`
                    : 'Nobody yet'}
                </dd>
                <dt>Family</dt>
                <dd>
                  {e.familyNotified} told · {e.familyOnTheWay} on the way
                </dd>
                {e.closeNote ? (
                  <>
                    <dt>Note</dt>
                    <dd>{e.closeNote}</dd>
                  </>
                ) : null}
              </dl>
              <ol className="stack" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
                {e.timeline.map((t, i) => (
                  <li key={i}>
                    {humanize(t.step)}
                    {t.firstName ? ` (${t.firstName})` : ''} · <span className="t-secondary">{formatDateTime(t.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <Dialog
        open={step === 'accept'}
        onClose={() => setStep(null)}
        title={`Answer ${e?.reference ?? ''}`}
        description="The household sees your first name, the minutes you pick counting down, and the duty phone."
        onSubmit={() => accept.mutate(undefined)}
        footer={
          <>
            <Button onClick={() => setStep(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={accept.isPending}>
              I am on the way
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Minutes away">
            {(p) => (
              <Select {...p} value={String(minutes)} onChange={(ev) => setMinutes(Number(ev.target.value) as (typeof MINUTES)[number])}>
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
        open={step === 'resolve'}
        onClose={() => setStep(null)}
        title={`Resolve ${e?.reference ?? ''}?`}
        description="The household sees it resolved and why, never your note."
        codes={REASON_CODES.emergencyResolve}
        confirmLabel="Resolve"
        pending={resolve.isPending}
        error={<ErrorAlert error={resolve.error} />}
        onConfirm={(reasonCode) => resolve.mutate(reasonCode)}
      >
        <Field label="Note (optional)" hint="For the management: up to 500 characters.">
          {(p) => <Textarea {...p} value={note} onChange={(ev) => setNote(ev.target.value)} />}
        </Field>
      </ReasonCodeDialog>
    </>
  );
}

/**
 * Emergencies, live (ADR 0047): the open ones oldest first, every ten
 * seconds; those nobody answered in time are marked. The management may
 * answer or resolve any. Never a resident's phone.
 */
export default function EmergenciesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('emergencies.manage') || can('emergencies.respond');
  const [view, setView] = useState<View>('open');
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.emergencies(view), (c) => fetchers.emergencies(view, c), {
    enabled: allowed,
    refetchInterval: view === 'open' ? 10_000 : undefined,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Emergencies" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Emergencies" description="Live: refreshed every ten seconds. Guards answer from the app; you can answer or resolve here." />
      <div className="toolbar">
        <Segmented<View>
          label="Emergencies shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffEmergency>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={view === 'open' ? 'No open emergency' : 'No emergency yet'}
            columns={[
              {
                key: 'ref',
                header: 'Emergency',
                cell: (e) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(e.id)}>
                    {e.reference}
                  </Button>
                ),
              },
              { key: 'type', header: 'Type', cell: (e) => humanize(e.type) },
              { key: 'where', header: 'Where', cell: (e) => where(e) },
              {
                key: 'status',
                header: 'Status',
                cell: (e) => (
                  <span className="row">
                    <StatusBadge status={e.status} />
                    {e.escalatedAt && e.status === 'reported' ? <Badge tone="error">Unanswered</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'responder',
                header: 'Responder',
                cell: (e) =>
                  e.responderAccount ? (
                    `${e.responderAccount.firstName ?? '—'}${e.minutesAway !== null ? ` · ${e.minutesAway} min` : ''}`
                  ) : (
                    <span className="t-secondary">Nobody yet</span>
                  ),
              },
              {
                key: 'when',
                header: 'Reported',
                cell: (e) => <span title={formatDateTime(e.reportedAt)}>{relativeTime(e.reportedAt)}</span>,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <EmergencyDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
