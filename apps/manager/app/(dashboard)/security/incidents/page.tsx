'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { addDays, personName, postName } from '@/components/security/logic';
import { dayStart, incidentActions } from '@/components/security/ops-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type IncidentFilters, type StaffIncident } from '@/lib/queries';

type Status = NonNullable<IncidentFilters['status']>;
type Note = StaffIncident['notes'][number];

const SEVERITY_TONE: Record<string, 'error' | 'terracotta' | 'beige' | 'green'> = {
  critical: 'error',
  high: 'terracotta',
  medium: 'beige',
  low: 'green',
};
const severity = (s: string) => <Badge tone={SEVERITY_TONE[s] ?? 'beige'}>{humanize(s)}</Badge>;
const where = (i: StaffIncident) =>
  [i.place?.nameEn, i.unit ? `unit ${i.unit.unitCode}` : null].filter(Boolean).join(' · ') || '—';

function Assign({ incident, onClose }: { incident: StaffIncident; onClose: () => void }) {
  const toast = useToast();
  const people = useQuery({ queryKey: keys.investigators, queryFn: fetchers.investigators });
  const [investigatorId, setInvestigator] = useState(incident.investigator?.id ?? '');
  const assign = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/incidents/{id}/assign', { params: { path: { id: incident.id } }, body: { investigatorId } }),
      ),
    {
      invalidate: [keys.securityIncidentsAll],
      onDone: () => {
        toast.show('Assigned. The investigator is told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Assign ${incident.reference}`}
      description="To someone who keeps the incidents. It moves to under investigation."
      onSubmit={() => investigatorId && assign.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={assign.isPending} disabled={!investigatorId}>
            Assign
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Investigator" error={fieldError(assign.error, 'investigatorId')}>
          {(p) => (
            <Select {...p} value={investigatorId} onChange={(e) => setInvestigator(e.target.value)}>
              <option value="">{people.isPending ? 'Loading…' : 'Select…'}</option>
              {(people.data?.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName ?? a.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={assign.error ?? people.error} />
      </div>
    </Dialog>
  );
}

function IncidentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const { me } = usePermissions();
  const incident = useQuery({ queryKey: keys.securityIncident(id), queryFn: () => fetchers.securityIncident(id) });
  const [step, setStep] = useState<'assign' | 'close' | null>(null);
  const [note, setNote] = useState('');
  const [closingNote, setClosingNote] = useState('');
  const addNote = useAction(
    () => unwrap(api.POST('/api/v1/staff/security/incidents/{id}/notes', { params: { path: { id } }, body: { body: note.trim() } })),
    {
      invalidate: [keys.securityIncidentsAll],
      onDone: () => {
        toast.show('Note added.');
        setNote('');
      },
    },
  );
  const acknowledge = useAction(
    () =>
      unwrap(api.POST('/api/v1/staff/security/incidents/{id}/acknowledge', { params: { path: { id } }, body: { role: 'reviewer' } })),
    { invalidate: [keys.securityIncidentsAll], onDone: () => toast.show('Acknowledged as reviewer.') },
  );
  const close = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/incidents/{id}/close', {
          params: { path: { id } },
          body: { reasonCode, note: closingNote.trim() },
        }),
      ),
    {
      invalidate: [keys.securityIncidentsAll],
      onDone: () => {
        toast.show('Closed.');
        setStep(null);
      },
    },
  );
  const i = incident.data;
  const actions = i ? incidentActions(i, me?.id) : [];
  return (
    <>
      <Dialog
        open={step === null || step === 'close'}
        wide
        onClose={onClose}
        title={i ? `${i.reference} · ${humanize(i.type)}` : 'Incident'}
        description={i ? `${where(i)} · happened ${formatDateTime(i.occurredAt)}` : undefined}
        footer={
          <>
            {actions.includes('acknowledge') ? (
              <Button loading={acknowledge.isPending} onClick={() => acknowledge.mutate(undefined)}>
                Acknowledge as reviewer
              </Button>
            ) : null}
            {actions.includes('assign') ? <Button onClick={() => setStep('assign')}>{i?.investigator ? 'Reassign' : 'Assign'}</Button> : null}
            {actions.includes('close') ? (
              <Button variant="primary" onClick={() => setStep('close')}>
                Close
              </Button>
            ) : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={incident} rows={6}>
          {i ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={i.status} /> {severity(i.severity)}
                  {i.outcome ? <span className="t-secondary"> · {humanize(i.outcome)}</span> : null}
                </dd>
                <dt>Reported</dt>
                <dd>
                  {formatDateTime(i.reportedAt)} · by {personName(i.reportedBy)}
                  {i.post ? ` · on shift at ${postName(i.post)}` : ''}
                </dd>
                <dt>Investigator</dt>
                <dd>{i.investigator ? `${personName(i.investigator)} · since ${formatDateTime(i.assignedAt ?? i.reportedAt)}` : 'Nobody yet'}</dd>
                <dt>What happened</dt>
                <dd>{i.description ?? <span className="t-secondary">The author’s words were erased.</span>}</dd>
                {i.links.emergencyId || i.links.gateServiceRequestId || i.links.patrolNoteId ? (
                  <>
                    <dt>Linked to</dt>
                    <dd>
                      {[
                        i.links.emergencyId ? 'an emergency' : null,
                        i.links.gateServiceRequestId ? 'a gate service request' : null,
                        i.links.patrolNoteId ? 'a patrol note' : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </dd>
                  </>
                ) : null}
                {i.closedAt ? (
                  <>
                    <dt>Closed</dt>
                    <dd>
                      {formatDateTime(i.closedAt)} · by {personName(i.closedBy)}
                      <div>{i.closingNote ?? <span className="t-secondary">The closer’s words were erased.</span>}</div>
                    </dd>
                  </>
                ) : null}
                <dt>Acknowledged</dt>
                <dd>
                  {i.acknowledgements.length
                    ? i.acknowledgements.map((a) => `${humanize(a.role)}: ${personName(a.account)}, ${formatDateTime(a.at)}`).join(' · ')
                    : 'Not yet'}
                </dd>
              </dl>
              {i.photos.length ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {i.photos.map((p, n) => (
                    <a key={p.url} className="btn btn--secondary btn--sm" href={p.url} target="_blank" rel="noreferrer">
                      Photo {n + 1}
                    </a>
                  ))}
                </div>
              ) : null}
              <Card flush>
                <CardHeader title="Internal notes" />
                <DataTable<Note>
                  rows={i.notes}
                  rowKey={(n) => n.id}
                  empty="No note"
                  columns={[
                    { key: 'when', header: 'When', cell: (n) => <span title={formatDateTime(n.at)}>{relativeTime(n.at)}</span> },
                    { key: 'by', header: 'By', cell: (n) => personName(n.author) },
                    { key: 'body', header: 'Note', cell: (n) => n.body ?? <span className="t-secondary">Erased</span> },
                  ]}
                />
              </Card>
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (note.trim()) addNote.mutate(undefined);
                }}
              >
                <Field label="Add a note" hint="The management’s only: the guards never read it." error={fieldError(addNote.error, 'body')}>
                  {(p) => <Textarea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
                </Field>
                <div>
                  <Button type="submit" loading={addNote.isPending} disabled={!note.trim()}>
                    Add note
                  </Button>
                </div>
              </form>
              <ErrorAlert error={addNote.error ?? acknowledge.error} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {i && step === 'assign' ? <Assign incident={i} onClose={() => setStep(null)} /> : null}
      <ReasonCodeDialog
        open={step === 'close'}
        onClose={() => setStep(null)}
        title={`Close ${i?.reference ?? ''}?`}
        description="Final: it changes no more. The guard who reported it sees the outcome, never the note."
        codes={REASON_CODES.incidentOutcome}
        codeLabel="Outcome"
        confirmLabel="Close"
        ready={closingNote.trim().length > 0}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => close.mutate(reasonCode)}
      >
        <Field label="Closing note" hint="Required. The management’s only." error={fieldError(close.error, 'note')}>
          {(p) => <Textarea {...p} rows={3} maxLength={2000} value={closingNote} onChange={(e) => setClosingNote(e.target.value)} />}
        </Field>
      </ReasonCodeDialog>
    </>
  );
}

/**
 * Incidents (ADR 0053), `incidents.manage`: reported by a guard on shift or
 * the office; assigned, noted, acknowledged and closed here. Residents
 * never see them.
 */
export default function IncidentsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('incidents.manage');
  const [status, setStatus] = useState<Status>('open');
  const [type, setType] = useState('');
  const [sev, setSev] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('incident');
    if (linked) setOpen(linked);
  }, []);
  const filters: IncidentFilters = {
    status,
    type: type as IncidentFilters['type'],
    severity: sev as IncidentFilters['severity'],
    from: dayStart(from),
    to: to ? dayStart(addDays(to, 1)) : undefined,
  };
  const list = useCursorList(keys.securityIncidents(filters), (c) => fetchers.securityIncidents(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Incidents" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Incidents" description="Reported by the guards on shift and the office. The incidents report counts them per type." />
      <div className="toolbar">
        <Segmented<Status>
          label="Incidents shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'investigating', label: 'Investigating' },
            { value: 'closed', label: 'Closed' },
            { value: '', label: 'All' },
          ]}
        />
        <Field label="Type">
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Every type</option>
              {REASON_CODES.incidentType.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Severity">
          {(p) => (
            <Select {...p} value={sev} onChange={(e) => setSev(e.target.value)}>
              <option value="">Every severity</option>
              {REASON_CODES.incidentSeverity.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Happened from">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffIncident>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="No incident matches"
            columns={[
              {
                key: 'ref',
                header: 'Incident',
                cell: (i) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                    {i.reference}
                  </Button>
                ),
              },
              { key: 'type', header: 'Type', cell: (i) => humanize(i.type) },
              { key: 'sev', header: 'Severity', cell: (i) => severity(i.severity) },
              { key: 'where', header: 'Where', cell: (i) => where(i) },
              { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'inv', header: 'Investigator', cell: (i) => (i.investigator ? personName(i.investigator) : '—') },
              { key: 'when', header: 'Happened', cell: (i) => <span title={formatDateTime(i.occurredAt)}>{relativeTime(i.occurredAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <IncidentDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
