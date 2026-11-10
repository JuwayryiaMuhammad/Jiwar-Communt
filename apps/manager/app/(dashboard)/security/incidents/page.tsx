'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Locale, type Translate } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CorrectiveActions } from '@/components/security/corrective-actions';
import { addDays, nameIn, personNameIn, postNameIn } from '@/components/security/logic';
import { dayStart, incidentActions } from '@/components/security/ops-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type IncidentFilters, type StaffIncident } from '@/lib/queries';
import ar from '@/messages/ar/safety-incidents';
import en from '@/messages/en/safety-incidents';

type Status = NonNullable<IncidentFilters['status']>;
type Note = StaffIncident['notes'][number];
const STATUSES = ['open', 'investigating', 'closed', ''] as const satisfies readonly Status[];

const SEVERITY_TONE: Record<string, 'error' | 'terracotta' | 'beige' | 'green'> = {
  critical: 'error',
  high: 'terracotta',
  medium: 'beige',
  low: 'green',
};

function Severity({ value }: { value: string }) {
  const label = useLabel();
  return <Badge tone={SEVERITY_TONE[value] ?? 'beige'}>{label(value)}</Badge>;
}

const where = (i: StaffIncident, t: Translate<typeof en>, locale: Locale) =>
  [i.place ? nameIn(i.place, locale) : null, i.unit ? t('unit', { code: i.unit.unitCode }) : null].filter(Boolean).join(' · ') || '—';

function Assign({ incident, onClose }: { incident: StaffIncident; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('assigned'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('assignTitle', { reference: incident.reference })}
      description={t('assignDescription')}
      onSubmit={() => investigatorId && assign.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={assign.isPending} disabled={!investigatorId}>
            {t('assign')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('investigator')} error={fieldError(assign.error, 'investigatorId')}>
          {(p) => (
            <Select {...p} value={investigatorId} onChange={(e) => setInvestigator(e.target.value)}>
              <option value="">{people.isPending ? t('loading') : c('select')}</option>
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(t('noteAdded'));
        setNote('');
      },
    },
  );
  const acknowledge = useAction(
    () =>
      unwrap(api.POST('/api/v1/staff/security/incidents/{id}/acknowledge', { params: { path: { id } }, body: { role: 'reviewer' } })),
    { invalidate: [keys.securityIncidentsAll], onDone: () => toast.show(t('acknowledgedToast')) },
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
        toast.show(t('closedToast'));
        setStep(null);
      },
    },
  );
  const i = incident.data;
  const actions = i ? incidentActions(i, me?.id) : [];
  const who = (ref: Parameters<typeof personNameIn>[0]) => personNameIn(ref, locale);
  const links = i
    ? [
        i.links.emergencyId ? t('link.emergency') : null,
        i.links.gateServiceRequestId ? t('link.serviceRequest') : null,
        i.links.patrolNoteId ? t('link.patrolNote') : null,
      ].filter((x): x is string => x !== null)
    : [];
  return (
    <>
      <Dialog
        open={step === null || step === 'close'}
        wide
        onClose={onClose}
        title={i ? `${i.reference} · ${label(i.type)}` : t('incident')}
        description={i ? t('detailDescription', { where: where(i, t, locale), when: fmt.dateTime(i.occurredAt) }) : undefined}
        footer={
          <>
            {actions.includes('acknowledge') ? (
              <Button loading={acknowledge.isPending} onClick={() => acknowledge.mutate(undefined)}>
                {t('acknowledge')}
              </Button>
            ) : null}
            {actions.includes('assign') ? <Button onClick={() => setStep('assign')}>{i?.investigator ? t('reassign') : t('assign')}</Button> : null}
            {actions.includes('close') ? (
              <Button
                variant="primary"
                disabled={(i?.actions.open ?? 0) > 0}
                title={(i?.actions.open ?? 0) > 0 ? t('actionsOpen') : undefined}
                onClick={() => setStep('close')}
              >
                {t('close')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{t('done')}</Button>
          </>
        }
      >
        <QueryState query={incident} rows={6}>
          {i ? (
            <div className="stack">
              <dl className="dl">
                <dt>{t('status')}</dt>
                <dd>
                  <StatusBadge status={i.status} /> <Severity value={i.severity} />
                  {i.outcome ? <span className="t-secondary"> · {label(i.outcome)}</span> : null}
                </dd>
                <dt>{t('reported')}</dt>
                <dd>
                  {i.post
                    ? t('reportedByOnShift', { when: fmt.dateTime(i.reportedAt), who: who(i.reportedBy), post: postNameIn(i.post, locale) })
                    : t('reportedBy', { when: fmt.dateTime(i.reportedAt), who: who(i.reportedBy) })}
                </dd>
                <dt>{t('investigator')}</dt>
                <dd>
                  {i.investigator
                    ? t('investigatorSince', { who: who(i.investigator), when: fmt.dateTime(i.assignedAt ?? i.reportedAt) })
                    : t('nobodyYet')}
                </dd>
                <dt>{t('whatHappened')}</dt>
                <dd>{i.description ?? <span className="t-secondary">{t('authorErased')}</span>}</dd>
                {links.length ? (
                  <>
                    <dt>{t('linkedTo')}</dt>
                    <dd>{fmt.list(links)}</dd>
                  </>
                ) : null}
                {i.closedAt ? (
                  <>
                    <dt>{t('closed')}</dt>
                    <dd>
                      {t('closedBy', { when: fmt.dateTime(i.closedAt), who: who(i.closedBy) })}
                      <div>{i.closingNote ?? <span className="t-secondary">{t('closerErased')}</span>}</div>
                    </dd>
                  </>
                ) : null}
                <dt>{t('acknowledged')}</dt>
                <dd>
                  {i.acknowledgements.length
                    ? i.acknowledgements
                        .map((a) => t('acknowledgement', { role: label(a.role), who: who(a.account), when: fmt.dateTime(a.at) }))
                        .join(' · ')
                    : t('notYet')}
                </dd>
              </dl>
              {i.photos.length ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {i.photos.map((p, n) => (
                    <a key={p.url} className="btn btn--secondary btn--sm" href={p.url} target="_blank" rel="noreferrer">
                      {t('photo', { n: n + 1 })}
                    </a>
                  ))}
                </div>
              ) : null}
              <Card flush>
                <CardHeader title={t('notes')} />
                <DataTable<Note>
                  rows={i.notes}
                  rowKey={(n) => n.id}
                  empty={t('noNote')}
                  columns={[
                    { key: 'when', header: t('col.when'), cell: (n) => <span title={fmt.dateTime(n.at)}>{fmt.relative(n.at)}</span> },
                    { key: 'by', header: t('col.by'), cell: (n) => who(n.author) },
                    { key: 'body', header: t('col.note'), cell: (n) => n.body ?? <span className="t-secondary">{t('erased')}</span> },
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
                <Field label={t('addNoteLabel')} hint={t('addNoteHint')} error={fieldError(addNote.error, 'body')}>
                  {(p) => <Textarea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
                </Field>
                <div>
                  <Button type="submit" loading={addNote.isPending} disabled={!note.trim()}>
                    {t('addNote')}
                  </Button>
                </div>
              </form>
              <ErrorAlert error={addNote.error ?? acknowledge.error} />
              <CorrectiveActions incidentId={i.id} closed={i.status === 'closed'} />
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {i && step === 'assign' ? <Assign incident={i} onClose={() => setStep(null)} /> : null}
      <ReasonCodeDialog
        open={step === 'close'}
        onClose={() => setStep(null)}
        title={t('closeTitle', { reference: i?.reference ?? '' })}
        description={t('closeDescription')}
        codes={REASON_CODES.incidentOutcome}
        codeLabel={t('outcome')}
        confirmLabel={t('close')}
        ready={closingNote.trim().length > 0}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => close.mutate(reasonCode)}
      >
        <Field label={t('closingNote')} hint={t('closingNoteHint')} error={fieldError(close.error, 'note')}>
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Status>
          label={t('shown')}
          value={status}
          onChange={setStatus}
          options={STATUSES.map((v) => ({ value: v, label: t(`view.${v || 'all'}`) }))}
        />
        <Field label={t('type')}>
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">{t('everyType')}</option>
              {REASON_CODES.incidentType.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('severity')}>
          {(p) => (
            <Select {...p} value={sev} onChange={(e) => setSev(e.target.value)}>
              <option value="">{t('everySeverity')}</option>
              {REASON_CODES.incidentSeverity.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('from')}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('to')}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffIncident>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('empty')}
            columns={[
              {
                key: 'ref',
                header: t('col.incident'),
                cell: (i) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(i.id)}>
                    {i.reference}
                  </Button>
                ),
              },
              { key: 'type', header: t('col.type'), cell: (i) => label(i.type) },
              { key: 'sev', header: t('col.severity'), cell: (i) => <Severity value={i.severity} /> },
              { key: 'where', header: t('col.where'), cell: (i) => where(i, t, locale) },
              { key: 'status', header: t('col.status'), cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'inv', header: t('col.investigator'), cell: (i) => (i.investigator ? personNameIn(i.investigator, locale) : '—') },
              {
                key: 'when',
                header: t('col.happened'),
                cell: (i) => <span title={fmt.dateTime(i.occurredAt)}>{fmt.relative(i.occurredAt)}</span>,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <IncidentDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
