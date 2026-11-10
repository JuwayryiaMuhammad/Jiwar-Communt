'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Format, type Locale, type Translate } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { listSep } from '@/components/security/logic';
import { classTone, type FlagClass } from '@/components/security/offline-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import {
  fetchers,
  keys,
  type OfflineBatch,
  type OfflineBatchFilter,
  type OfflineFlag,
  type OfflineFlagClass,
  type OfflineFlagFilter,
} from '@/lib/queries';
import ar from '@/messages/ar/safety-offline-flags';
import en from '@/messages/en/safety-offline-flags';

type Tab = 'flags' | 'batches';
const TABS = ['flags', 'batches'] as const satisfies readonly Tab[];
const FLAG_VIEWS = ['open', 'reviewed', 'cleared', 'all'] as const satisfies readonly OfflineFlagFilter[];
const CLASSES = ['any', 'security', 'manager', 'info'] as const satisfies readonly (OfflineFlagClass | 'any')[];
const BATCH_VIEWS = ['pending', 'reviewed', 'all'] as const satisfies readonly OfflineBatchFilter[];
type Label = (code: string | null | undefined) => string;

/** A flag's words, with what its codes and numbers add (offline-logic's flagText, in the page's language). */
function flagWords(f: { kind: string; params: Record<string, unknown> }, t: Translate<typeof en>, label: Label, locale: Locale): string {
  const key = `flag.${f.kind}`;
  const base = key in en ? t(key as keyof typeof en) : label(f.kind);
  const p = f.params ?? {};
  const extra: string[] = [];
  if (typeof p.reason === 'string' && p.reason !== f.kind) extra.push(label(p.reason));
  if (typeof p.code === 'string') extra.push(label(p.code.toLowerCase()));
  if (typeof p.skewSeconds === 'number') extra.push(t('extra.skew', { s: Math.abs(p.skewSeconds), side: p.skewSeconds < 0 ? 'early' : 'late' }));
  if (typeof p.offsetSeconds === 'number')
    extra.push(t('extra.offset', { s: Math.abs(p.offsetSeconds), side: p.offsetSeconds < 0 ? 'behind' : 'ahead' }));
  if (typeof p.matches === 'number') extra.push(t('extra.matches', { n: p.matches }));
  return extra.length ? `${base} (${extra.join(listSep(locale))})` : base;
}

/** What a quarantined batch holds, by what each action says it was (offline-logic's batchSummary, in the page's language). */
function batchWords(actions: { type: string; status: string }[], label: Label, fmt: Format): string {
  const counts = new Map<string, number>();
  for (const a of actions) if (a.status === 'quarantined') counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${fmt.number(n)} × ${label(type)}`)
    .join(listSep(fmt.locale));
}

/** Reviewed once, with a code: what the management made of it. */
function Review({ f, onClose }: { f: OfflineFlag; onClose: () => void }) {
  const t = useT(en, ar);
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const review = useAction(
    (reviewCode: (typeof REASON_CODES.offlineFlagReview)[number]) =>
      unwrap(
        api.POST('/api/v1/staff/gate/offline/flags/{id}/review', {
          params: { path: { id: f.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { reviewCode },
        }),
      ),
    {
      invalidate: [keys.offlineAll],
      onDone: () => {
        toast.show(t('reviewed'));
        onClose();
      },
    },
  );
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={t('reviewTitle')}
      description={flagWords(f, t, label, locale)}
      codes={REASON_CODES.offlineFlagReview}
      confirmLabel={t('review')}
      pending={review.isPending}
      error={<ErrorAlert error={review.error} />}
      onConfirm={(reviewCode) => review.mutate(reviewCode as (typeof REASON_CODES.offlineFlagReview)[number])}
    />
  );
}

/** A revoked device's batch, decided once: accept records it as at its receipt; reject keeps it rejected. */
function Decide({ b, decision, onClose }: { b: OfflineBatch; decision: 'accept' | 'reject'; onClose: () => void }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/gate/offline/batches/{id}/review', {
          params: { path: { id: b.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { decision },
        }),
      ),
    {
      invalidate: [keys.offlineAll],
      onDone: () => {
        toast.show(decision === 'accept' ? t('acceptedToast') : t('rejectedToast'));
        onClose();
      },
    },
  );
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={decision === 'accept' ? t('acceptTitle') : t('rejectTitle')}
      description={t('decideDescription', { summary: batchWords(b.actions, label, fmt), when: fmt.dateTime(b.receivedAt), decision })}
      confirmLabel={decision === 'accept' ? t('accept') : t('reject')}
      danger={decision === 'reject'}
      pending={decide.isPending}
      error={<ErrorAlert error={decide.error} />}
      onConfirm={() => decide.mutate()}
    />
  );
}

function BatchDetail({ id, onClose, onDecide }: { id: string; onClose: () => void; onDecide: (b: OfflineBatch, d: 'accept' | 'reject') => void }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const detail = useQuery({ queryKey: keys.offlineBatch(id), queryFn: () => fetchers.offlineBatch(id) });
  const b = detail.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('batchTitle')}
      footer={
        <>
          {b?.pendingReview ? (
            <>
              <Button variant="danger" onClick={() => onDecide(b, 'reject')}>
                {t('reject')}
              </Button>
              <Button variant="primary" onClick={() => onDecide(b, 'accept')}>
                {t('accept')}
              </Button>
            </>
          ) : null}
          <Button onClick={onClose}>{t('done')}</Button>
        </>
      }
    >
      <QueryState query={detail} rows={6}>
        {b ? (
          <>
            <dl className="dl">
              <dt>{t('uploaded')}</dt>
              <dd>
                {b.uploadedBy.fullName ?? t('erased')} · {fmt.dateTime(b.receivedAt)}
              </dd>
              <dt>{t('as')}</dt>
              <dd>{b.status === 'quarantined' ? t('fromRevoked') : t('accepted')}</dd>
              {b.reviewedAt ? (
                <>
                  <dt>{t('decided')}</dt>
                  <dd>
                    {label(b.reviewDecision)} · {b.reviewedBy?.fullName ?? '—'} · {fmt.dateTime(b.reviewedAt)}
                  </dd>
                </>
              ) : null}
            </dl>
            <DataTable<OfflineBatch['actions'][number]>
              rows={b.actions}
              rowKey={(a) => a.clientId}
              empty={t('noAction')}
              columns={[
                { key: 'seq', header: t('col.seq'), cell: (a) => fmt.number(a.seq) },
                { key: 'type', header: t('col.what'), cell: (a) => label(a.type) + (a.direction ? ` (${label(a.direction)})` : '') },
                { key: 'when', header: t('col.whenDevice'), cell: (a) => fmt.dateTime(a.deviceTime) },
                { key: 'status', header: t('col.now'), cell: (a) => (a.reason ? `${label(a.status)}: ${label(a.reason)}` : label(a.status)) },
              ]}
            />
          </>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/**
 * Offline flags (ADR 0057): what the server knew better when a guard
 * device synced what it recorded without network — someone let in during
 * a lockdown, a banned plate, a once-only code used twice, a credential
 * revoked since — and the batches a revoked device uploaded, waiting to be
 * accepted or rejected. Codes and numbers only: open the entry's log for
 * the rest.
 */
export default function OfflineFlagsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('gate_devices.manage');
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('batch') ? 'batches' : 'flags');
  const [status, setStatus] = useState<OfflineFlagFilter>('open');
  const [klass, setKlass] = useState<OfflineFlagClass | 'any'>('any');
  const [batchStatus, setBatchStatus] = useState<OfflineBatchFilter>('pending');
  const [reviewing, setReviewing] = useState<OfflineFlag | null>(null);
  const [batch, setBatch] = useState<string | null>(params.get('batch'));
  const [deciding, setDeciding] = useState<{ b: OfflineBatch; decision: 'accept' | 'reject' } | null>(null);
  const device = params.get('device') ?? undefined;
  const flags = useCursorList(
    keys.offlineFlags(status, klass, device),
    (c) => fetchers.offlineFlags(status, klass === 'any' ? undefined : klass, device, c),
    {
      enabled: allowed && tab === 'flags',
      refetchInterval: 60_000,
    },
  );
  const batches = useCursorList(keys.offlineBatches(batchStatus), (c) => fetchers.offlineBatches(batchStatus, c), {
    enabled: allowed && tab === 'batches',
  });
  const classWord = (c: string) => (c === 'security' || c === 'manager' || c === 'info' ? t(`class.${c}`) : label(c));

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
        <Segmented<Tab> label={t('show')} value={tab} onChange={setTab} options={TABS.map((v) => ({ value: v, label: t(`tab.${v}`) }))} />
        {tab === 'flags' ? (
          <>
            <Segmented<OfflineFlagFilter>
              label={t('flagsShown')}
              value={status}
              onChange={setStatus}
              options={FLAG_VIEWS.map((v) => ({ value: v, label: t(`flags.${v}`) }))}
            />
            <Segmented<OfflineFlagClass | 'any'>
              label={t('kind')}
              value={klass}
              onChange={setKlass}
              options={CLASSES.map((v) => ({ value: v, label: t(`class.${v}`) }))}
            />
          </>
        ) : (
          <Segmented<OfflineBatchFilter>
            label={t('batchesShown')}
            value={batchStatus}
            onChange={setBatchStatus}
            options={BATCH_VIEWS.map((v) => ({ value: v, label: t(`batches.${v}`) }))}
          />
        )}
      </div>
      {tab === 'flags' ? (
        <Card flush>
          <QueryState query={flags}>
            <DataTable<OfflineFlag>
              rows={flags.rows}
              rowKey={(f) => f.id}
              empty={status === 'open' ? t('emptyOpen') : t('emptyFlags')}
              columns={[
                {
                  key: 'what',
                  header: t('col.what'),
                  cell: (f) => (
                    <span className="row">
                      <Badge tone={classTone(f.class as FlagClass)}>{classWord(f.class)}</Badge>
                      {flagWords(f, t, label, locale)}
                    </span>
                  ),
                },
                { key: 'when', header: t('col.whenDevice'), cell: (f) => (f.occurredAt ? fmt.dateTime(f.occurredAt) : '—') },
                { key: 'synced', header: t('col.synced'), cell: (f) => <span title={fmt.dateTime(f.createdAt)}>{fmt.relative(f.createdAt)}</span> },
                {
                  key: 'batch',
                  header: '',
                  cell: (f) => (
                    <span className="row">
                      <Button size="sm" variant="text" onClick={() => setBatch(f.batchId)}>
                        {t('batch')}
                      </Button>
                      {f.status === 'open' ? (
                        <Button size="sm" variant="primary" onClick={() => setReviewing(f)}>
                          {t('review')}
                        </Button>
                      ) : (
                        <Badge tone="beige">{label(f.status)}</Badge>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            <LoadMore query={flags} />
          </QueryState>
        </Card>
      ) : (
        <Card flush>
          <QueryState query={batches}>
            <DataTable<OfflineBatch>
              rows={batches.rows}
              rowKey={(b) => b.id}
              empty={batchStatus === 'pending' ? t('emptyPending') : t('emptyBatches')}
              columns={[
                {
                  key: 'what',
                  header: t('col.what'),
                  cell: (b) => (
                    <Button variant="text" className="table__link" onClick={() => setBatch(b.id)}>
                      {t('actions', { n: b.actionCount })}
                    </Button>
                  ),
                },
                {
                  key: 'as',
                  header: t('col.as'),
                  cell: (b) =>
                    b.pendingReview ? <Badge tone="error">{t('quarantined')}</Badge> : b.reviewDecision ? label(b.reviewDecision) : t('accepted'),
                },
                { key: 'by', header: t('col.uploadedBy'), cell: (b) => b.uploadedBy.fullName ?? t('erased') },
                { key: 'when', header: t('col.received'), cell: (b) => <span title={fmt.dateTime(b.receivedAt)}>{fmt.relative(b.receivedAt)}</span> },
                {
                  key: 'decide',
                  header: '',
                  cell: (b) =>
                    b.pendingReview ? (
                      <span className="row">
                        <Button size="sm" variant="primary" onClick={() => setDeciding({ b, decision: 'accept' })}>
                          {t('accept')}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setDeciding({ b, decision: 'reject' })}>
                          {t('reject')}
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
            <LoadMore query={batches} />
          </QueryState>
        </Card>
      )}
      {reviewing ? <Review f={reviewing} onClose={() => setReviewing(null)} /> : null}
      {batch ? <BatchDetail id={batch} onClose={() => setBatch(null)} onDecide={(b, decision) => setDeciding({ b, decision })} /> : null}
      {deciding ? <Decide b={deciding.b} decision={deciding.decision} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}
