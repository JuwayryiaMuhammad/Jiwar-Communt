'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Translate } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { localName } from '@/components/management-requests/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GateServiceFilters, type GateServiceKind, type StaffGateService } from '@/lib/queries';
import ar from '@/messages/ar/gate-services';
import en from '@/messages/en/gate-services';

const VIEWS = ['open', 'accepted', 'in_progress', 'closed', 'all'] as const;
type View = (typeof VIEWS)[number];
const KINDS: (GateServiceKind | '')[] = ['', 'accessibility', 'suspicious', 'escort', 'lane'];
const MINUTES = [2, 5, 10, 15] as const;

/** One line of what was asked, in the page's language. */
function useAsked() {
  const t = useT(en, ar);
  const label = useLabel();
  const { locale } = useLocale();
  return (r: StaffGateService): string => {
    const place = (p: { nameEn: string; nameAr?: string | null } | null | undefined, fallback = '—') => (p ? localName(locale, p) : fallback);
    switch (r.kind) {
      case 'accessibility': {
        const help = label(r.assistanceKind);
        const from = place(r.fromPlace);
        const to = place(r.toPlace, t('asked.theUnit'));
        return r.member
          ? t('asked.accessibilityFor', { help, member: r.member.firstName ?? t('asked.aMember'), from, to })
          : t('asked.accessibility', { help, from, to });
      }
      case 'escort':
        return t('asked.escort', { from: place(r.fromPlace), to: place(r.toPlace) });
      case 'suspicious':
        return t('asked.suspicious', { place: place(r.place) });
      case 'lane':
        return t('asked.lane', { reason: label(r.laneReason), gate: r.gate?.name ?? '—' });
    }
  };
}

function ServiceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const asked = useAsked();
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
        toast.show(t('accepted'));
        setStep(null);
      },
    },
  );
  const start = useAction(() => unwrap(api.POST('/api/v1/gate/gate-services/{id}/start', { params: { path: { id } } })), {
    invalidate: [keys.gateServicesAll],
    onDone: () => toast.show(t('started')),
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
        toast.show(t('closed'));
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
        title={r ? `${r.reference} · ${label(r.kind)}` : t('request')}
        description={r ? asked(r) : undefined}
        footer={
          <>
            {r?.status === 'open' ? (
              <Button variant="primary" onClick={() => setStep('accept')}>
                {t('accept')}
              </Button>
            ) : null}
            {r?.status === 'accepted' && r.isMine ? (
              <Button loading={start.isPending} onClick={() => start.mutate(undefined)}>
                {t('start')}
              </Button>
            ) : null}
            {live ? <Button onClick={() => setStep('close')}>{c('close')}</Button> : null}
            <Button onClick={onClose}>{t('done')}</Button>
          </>
        }
      >
        <QueryState query={request} rows={5}>
          {r ? (
            <div className="stack">
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.closeReason ? <span className="t-secondary"> · {label(r.closeReason)}</span> : null}
                </dd>
                <dt>{t('askedBy')}</dt>
                <dd>
                  {r.requestedBy.erased ? t('erasedAccount') : r.requestedBy.firstName} · {r.location.unitCode} · {f.dateTime(r.createdAt)}
                </dd>
                {r.wantedAt ? (
                  <>
                    <dt>{t('wanted')}</dt>
                    <dd>{f.dateTime(r.wantedAt)}</dd>
                  </>
                ) : null}
                <dt>{t('handledBy')}</dt>
                <dd>
                  {r.handledBy
                    ? r.minutesAway !== null
                      ? t('minutesAway', { name: r.handledBy.firstName ?? '—', minutes: f.number(r.minutesAway) })
                      : (r.handledBy.firstName ?? '—')
                    : t('nobodyYet')}
                </dd>
                {r.description ? (
                  <>
                    <dt>{t('saw')}</dt>
                    <dd>{r.description}</dd>
                  </>
                ) : null}
                {r.notes ? (
                  <>
                    <dt>{c('notes')}</dt>
                    <dd>{r.notes}</dd>
                  </>
                ) : null}
                {r.closeNote ? (
                  <>
                    <dt>{t('ourNote')}</dt>
                    <dd>{r.closeNote}</dd>
                  </>
                ) : null}
              </dl>
              {r.photoUrl ? (
                <a className="btn btn--secondary btn--sm" href={r.photoUrl} target="_blank" rel="noreferrer">
                  {t('openPhoto')}
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
        title={t('acceptTitle', { reference: r?.reference ?? '' })}
        description={t('acceptDescription')}
        onSubmit={() => accept.mutate(undefined)}
        footer={
          <>
            <Button onClick={() => setStep(null)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={accept.isPending}>
              {t('accept')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('minutesLabel')} hint={t('minutesHint')}>
            {(p) => (
              <Select
                {...p}
                value={String(minutes)}
                onChange={(ev) => setMinutes(ev.target.value ? (Number(ev.target.value) as (typeof MINUTES)[number]) : '')}
              >
                <option value="">{c('none')}</option>
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
        open={step === 'close'}
        onClose={() => setStep(null)}
        title={t('closeTitle', { reference: r?.reference ?? '' })}
        description={t('closeDescription')}
        codes={REASON_CODES.gateServiceClose}
        confirmLabel={c('close')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => close.mutate(reasonCode)}
      >
        <Field label={t('noteLabel')} hint={t('noteHint')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const asked = useAsked();
  const { ready, can } = usePermissions();
  const allowed = can('gate_services.handle');
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<GateServiceKind | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const filters: GateServiceFilters = { status: view === 'all' ? '' : view, kind };
  const list = useCursorList(keys.gateServices(filters), (cursor) => fetchers.gateServices(filters, cursor), {
    enabled: allowed,
    refetchInterval: 30_000,
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
          options={VIEWS.map((v) => ({ value: v, label: v === 'all' ? c('all') : label(v) }))}
        />
        <Field label={c('kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as GateServiceKind | '')}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k ? label(k) : t('allKinds')}
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
            empty={view === 'open' ? t('emptyOpen') : t('empty')}
            columns={[
              {
                key: 'ref',
                header: t('col.request'),
                cell: (r) => (
                  <Button variant="text" className="table__link t-mono" onClick={() => setOpen(r.id)}>
                    {r.reference}
                  </Button>
                ),
              },
              { key: 'kind', header: c('kind'), cell: (r) => label(r.kind) },
              { key: 'what', header: t('col.what'), cell: (r) => asked(r) },
              { key: 'unit', header: c('unit'), cell: (r) => r.location.unitCode },
              { key: 'status', header: c('status'), cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'when', header: t('col.asked'), cell: (r) => <span title={f.dateTime(r.createdAt)}>{f.relative(r.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <ServiceDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
