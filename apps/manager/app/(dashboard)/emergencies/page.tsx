'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { postNameIn } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffEmergency } from '@/lib/queries';
import ar from '@/messages/ar/gate-emergencies';
import en from '@/messages/en/gate-emergencies';

const VIEWS = ['open', 'closed'] as const;
type View = (typeof VIEWS)[number];
const MINUTES = [2, 5, 10, 15] as const;

/** Where: "Building 7 · 12", or a guard's post for their SOS (ADR 0053). */
function useWhere() {
  const t = useT(en, ar);
  const { locale } = useLocale();
  return (e: StaffEmergency) =>
    e.location
      ? [e.location.building, e.location.unitCode].filter(Boolean).join(' · ')
      : e.post
        ? t('guardSos', { post: postNameIn(e.post, locale) })
        : '—';
}

function EmergencyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const where = useWhere();
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
        toast.show(t('answered'));
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
        toast.show(t('resolved'));
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
        title={e ? `${e.reference} · ${label(e.type)}` : t('emergency')}
        description={e ? where(e) : undefined}
        footer={
          <>
            {open && !e?.responderAccount ? (
              <Button variant="primary" onClick={() => setStep('accept')}>
                {t('answerIt')}
              </Button>
            ) : null}
            {open ? <Button onClick={() => setStep('resolve')}>{t('resolve')}</Button> : null}
            <Button onClick={onClose}>{t('done')}</Button>
          </>
        }
      >
        <QueryState query={emergency} rows={5}>
          {e ? (
            <div className="stack">
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={e.status} />
                  {e.escalatedAt ? (
                    <>
                      {' '}
                      <Badge tone="error">{e.escalationReason === 'no_responders' ? t('noResponders') : t('notInTime')}</Badge>
                    </>
                  ) : null}
                  {e.closeReason ? <span className="t-secondary"> · {label(e.closeReason)}</span> : null}
                </dd>
                <dt>{t('reportedBy')}</dt>
                <dd>
                  {e.reportedBy.erased ? t('erasedAccount') : e.reportedBy.firstName} · {f.dateTime(e.reportedAt)}
                </dd>
                <dt>{t('responder')}</dt>
                <dd>
                  {e.responderAccount
                    ? e.minutesAway !== null
                      ? t('responderLine', {
                          name: e.responderAccount.erased ? t('erasedAccount') : (e.responderAccount.firstName ?? '—'),
                          minutes: f.number(e.minutesAway),
                        })
                      : e.responderAccount.erased
                        ? t('erasedAccount')
                        : (e.responderAccount.firstName ?? '—')
                    : t('nobodyYet')}
                </dd>
                <dt>{t('family')}</dt>
                <dd>{t('familyLine', { told: f.number(e.familyNotified), onTheWay: f.number(e.familyOnTheWay) })}</dd>
                {e.closeNote ? (
                  <>
                    <dt>{c('note')}</dt>
                    <dd>{e.closeNote}</dd>
                  </>
                ) : null}
              </dl>
              <ol className="stack" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
                {e.timeline.map((step, i) => (
                  <li key={i}>
                    {label(step.step)}
                    {step.firstName ? ` (${step.firstName})` : ''} · <span className="t-secondary">{f.dateTime(step.at)}</span>
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
        title={t('answerTitle', { reference: e?.reference ?? '' })}
        description={t('answerDescription')}
        onSubmit={() => accept.mutate(undefined)}
        footer={
          <>
            <Button onClick={() => setStep(null)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={accept.isPending}>
              {t('onTheWay')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('minutesLabel')}>
            {(p) => (
              <Select {...p} value={String(minutes)} onChange={(ev) => setMinutes(Number(ev.target.value) as (typeof MINUTES)[number])}>
                {MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {t('minutes', { m })}
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
        title={t('resolveTitle', { reference: e?.reference ?? '' })}
        description={t('resolveDescription')}
        codes={REASON_CODES.emergencyResolve}
        confirmLabel={t('resolve')}
        pending={resolve.isPending}
        error={<ErrorAlert error={resolve.error} />}
        onConfirm={(reasonCode) => resolve.mutate(reasonCode)}
      >
        <Field label={t('noteLabel')} hint={t('noteHint')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const where = useWhere();
  const { ready, can } = usePermissions();
  const allowed = can('emergencies.manage') || can('emergencies.respond');
  const [view, setView] = useState<View>('open');
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.emergencies(view), (cursor) => fetchers.emergencies(view, cursor), {
    enabled: allowed,
    refetchInterval: view === 'open' ? 10_000 : undefined,
  });
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
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffEmergency>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={view === 'open' ? t('emptyOpen') : t('empty')}
            columns={[
              {
                key: 'ref',
                header: t('col.emergency'),
                cell: (e) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(e.id)}>
                    {e.reference}
                  </Button>
                ),
              },
              { key: 'type', header: c('type'), cell: (e) => label(e.type) },
              { key: 'where', header: t('col.where'), cell: (e) => where(e) },
              {
                key: 'status',
                header: c('status'),
                cell: (e) => (
                  <span className="row">
                    <StatusBadge status={e.status} />
                    {e.escalatedAt && e.status === 'reported' ? <Badge tone="error">{t('unanswered')}</Badge> : null}
                  </span>
                ),
              },
              {
                key: 'responder',
                header: t('col.responder'),
                cell: (e) =>
                  e.responderAccount ? (
                    e.minutesAway !== null ? (
                      t('responderShort', { name: e.responderAccount.firstName ?? '—', minutes: f.number(e.minutesAway) })
                    ) : (
                      (e.responderAccount.firstName ?? '—')
                    )
                  ) : (
                    <span className="t-secondary">{t('nobodyYet')}</span>
                  ),
              },
              {
                key: 'when',
                header: t('col.reported'),
                cell: (e) => <span title={f.dateTime(e.reportedAt)}>{f.relative(e.reportedAt)}</span>,
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
