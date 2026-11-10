'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT, type Format, type Translate } from '@jiwar/i18n';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, ReasonCodeDialog, Textarea, useCommonT, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AssetTimelineEntry, type WarrantyClaim } from '@/lib/queries';
import ar from '@/messages/ar/assets-asset';
import en from '@/messages/en/assets-asset';

const KINDS = [
  'asset_event',
  'ticket_opened',
  'ticket_completed',
  'ticket_closed',
  'part_issued',
  'part_returned',
  'cost',
  'warranty_claim_opened',
  'warranty_claim_decided',
] as const;

const detail = (e: AssetTimelineEntry, t: Translate<typeof en>, fmt: Format, label: (code: string) => string): string =>
  [
    e.code ? label(e.code) : null,
    e.fromValue || e.toValue ? t('change', { from: e.fromValue ?? '—', to: e.toValue ?? '—' }) : null,
    e.reasonCode ? label(e.reasonCode) : null,
    e.amount ? fmt.money(e.amount) : null,
    e.quantity ? t('quantity', { n: fmt.number(e.quantity) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** An asset's whole history (ADR 0076): events, tickets, parts, costs, warranty claims. */
export function AssetTimeline({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const list = useCursorList(keys.assetTimeline(id), (c) => fetchers.assetTimeline(id, c));
  return (
    <Card flush>
      <CardHeader title={t('timeline')} />
      <QueryState query={list}>
        <DataTable<AssetTimelineEntry>
          rows={list.rows}
          rowKey={(e) => `${e.kind}:${e.id}`}
          empty={t('nothingYet')}
          columns={[
            { key: 'when', header: t('col.when'), width: 170, cell: (e) => fmt.dateTime(e.at) },
            { key: 'kind', header: t('col.what'), cell: (e) => ((KINDS as readonly string[]).includes(e.kind) ? t(`kind.${e.kind}`) : label(e.kind)) },
            { key: 'detail', header: t('col.detail'), cell: (e) => detail(e, t, fmt, label) || '—' },
            {
              key: 'ticket',
              header: t('col.ticket'),
              cell: (e) =>
                e.ticketId ? (
                  <Link className="table__link t-mono" href={`/maintenance/${e.ticketId}`}>
                    {e.ticketNumber ?? t('open')}
                  </Link>
                ) : null,
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

/** The claims under an asset's warranty (ADR 0076): made while it runs, decided once. */
export function WarrantyClaims({ assetId, underWarranty }: { assetId: string; underWarranty: boolean }) {
  const t = useT(en, ar);
  const common = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const toast = useToast();
  const list = useCursorList(keys.warrantyClaims({ assetId }), (c) => fetchers.warrantyClaims({ assetId }, c));
  const [creating, setCreating] = useState(false);
  const [description, setDescription] = useState('');
  const [deciding, setDeciding] = useState<{ claim: WarrantyClaim; how: 'reject' | 'withdraw' } | null>(null);
  const [accepting, setAccepting] = useState<WarrantyClaim | null>(null);
  const [amount, setAmount] = useState('');
  const refresh = { invalidate: [keys.warrantyClaims({ assetId }), keys.assetTimeline(assetId)] };

  const create = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/warranty-claims', { body: { assetId, description: description.trim() } })),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('claimOpened'));
        setCreating(false);
        setDescription('');
      },
    },
  );
  const accept = useAction(
    (id: string) =>
      unwrap(
        api.POST('/api/v1/maintenance/warranty-claims/{id}/accept', {
          params: { path: { id } },
          body: amount.trim() ? { recoveredAmount: amount.trim() } : {},
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('claimAccepted'));
        setAccepting(null);
        setAmount('');
      },
    },
  );
  const decide = useAction(
    (input: { id: string; how: 'reject' | 'withdraw'; reasonCode: string }) =>
      unwrap(
        input.how === 'reject'
          ? api.POST('/api/v1/maintenance/warranty-claims/{id}/reject', {
              params: { path: { id: input.id } },
              body: { reasonCode: input.reasonCode },
            })
          : api.POST('/api/v1/maintenance/warranty-claims/{id}/withdraw', {
              params: { path: { id: input.id } },
              body: { reasonCode: input.reasonCode },
            }),
      ),
    { ...refresh, onDone: () => setDeciding(null) },
  );

  return (
    <Card flush>
      <CardHeader
        title={t('claims')}
        actions={
          underWarranty ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              {t('newClaim')}
            </Button>
          ) : null
        }
      />
      <QueryState query={list}>
        <DataTable<WarrantyClaim>
          rows={list.rows}
          rowKey={(c) => c.id}
          empty={t('noClaim')}
          columns={[
            { key: 'opened', header: t('col.opened'), width: 170, cell: (c) => fmt.dateTime(c.openedAt) },
            { key: 'what', header: t('col.failed'), cell: (c) => c.description },
            { key: 'ref', header: t('col.reference'), cell: (c) => (c.reference ? <bdi>{c.reference}</bdi> : '—') },
            {
              key: 'status',
              header: t('col.status'),
              cell: (c) => (
                <span className="row" style={{ gap: 6 }}>
                  <Badge>{label(c.status)}</Badge>
                  {c.reasonCode ? <span className="t-secondary">{label(c.reasonCode)}</span> : null}
                  {c.recoveredAmount ? <span className="t-secondary">{fmt.money(c.recoveredAmount)}</span> : null}
                </span>
              ),
            },
            {
              key: 'act',
              header: '',
              cell: (c) =>
                c.status === 'open' ? (
                  <span className="row" style={{ gap: 6 }}>
                    <Button size="sm" onClick={() => setAccepting(c)}>
                      {t('markAccepted')}
                    </Button>
                    <Button size="sm" onClick={() => setDeciding({ claim: c, how: 'reject' })}>
                      {t('markRejected')}
                    </Button>
                    <Button size="sm" onClick={() => setDeciding({ claim: c, how: 'withdraw' })}>
                      {t('withdraw')}
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('claimTitle')}
        description={t('claimDescription')}
        onSubmit={() => description.trim() && create.mutate()}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{common('cancel')}</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!description.trim()}>
              {t('openClaim')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('whatFailed')}>
            {(p) => <Textarea {...p} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <ErrorAlert error={create.error} />
        </div>
      </Dialog>
      <Dialog
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title={t('acceptedTitle')}
        onSubmit={() => accepting && accept.mutate(accepting.id)}
        footer={
          <>
            <Button onClick={() => setAccepting(null)}>{common('cancel')}</Button>
            <Button type="submit" variant="primary" loading={accept.isPending}>
              {t('record')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('recovered')} hint={common('optional')}>
            {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <ErrorAlert error={accept.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding?.how === 'reject' ? t('rejectedTitle') : t('withdrawTitle')}
        codes={deciding?.how === 'reject' ? REASON_CODES.warrantyClaimReject : REASON_CODES.warrantyClaimWithdraw}
        confirmLabel={deciding?.how === 'reject' ? t('record') : t('withdraw')}
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => deciding && decide.mutate({ id: deciding.claim.id, how: deciding.how, reasonCode })}
      />
    </Card>
  );
}
