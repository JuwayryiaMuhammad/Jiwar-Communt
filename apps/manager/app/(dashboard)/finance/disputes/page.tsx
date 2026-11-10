'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { validMoney } from '@/components/finance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type StaffDispute } from '@/lib/queries';
import ar from '@/messages/ar/fin-disputes';
import en from '@/messages/en/fin-disputes';

type View = 'open' | 'accepted' | 'rejected' | 'all';

function DisputeDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const dispute = useQuery({ queryKey: keys.dispute(id), queryFn: () => fetchers.dispute(id) });
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [amount, setAmount] = useState('');
  const decide = useAction(
    (body: { decision: 'accept'; amount: string } | { decision: 'reject'; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/staff/invoice-disputes/{id}/decide', { params: { path: { id } }, body })),
    {
      invalidate: [keys.invoicesAll],
      onDone: (d) => {
        toast.show(
          d.status === 'accepted'
            ? t('acceptedToast', { amount: f.money(d.decision?.creditedAmount ?? '0'), number: d.decision?.creditNoteNumber ?? '' })
            : t('rejectedToast'),
        );
        setAccepting(false);
        setRejecting(false);
      },
    },
  );
  const d = dispute.data;
  const open = d?.status === 'open';
  return (
    <>
      <Dialog
        open={!accepting && !rejecting}
        wide
        onClose={onClose}
        title={d ? t('detailTitle', { invoice: d.invoiceNumber, unit: d.unitCode }) : t('dispute')}
        description={d ? t('detailDescription', { reason: label(d.reasonCode), when: f.dateTime(d.createdAt) }) : undefined}
        footer={
          <>
            {open ? (
              <>
                <Button variant="danger" onClick={() => setRejecting(true)}>
                  {t('reject')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setAmount(Number(d.outstanding) > 0 ? d.outstanding : '');
                    setAccepting(true);
                  }}
                >
                  {t('accept')}
                </Button>
              </>
            ) : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={dispute} rows={4}>
          {d ? (
            <div className="stack">
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={d.status} />
                </dd>
                <dt>{t('owesNow')}</dt>
                <dd>{f.money(d.outstanding)}</dd>
                <dt>{t('words')}</dt>
                <dd>{d.cleared ? <span className="t-secondary">{t('erased')}</span> : (d.text ?? '—')}</dd>
                {d.decision ? (
                  <>
                    <dt>{t('decision')}</dt>
                    <dd>
                      {d.decision.creditNoteNumber
                        ? t('credited', { amount: f.money(d.decision.creditedAmount ?? '0'), number: d.decision.creditNoteNumber })
                        : label(d.decision.reasonCode)}{' '}
                      · {f.dateTime(d.decision.decidedAt)}
                    </dd>
                  </>
                ) : null}
              </dl>
              {d.photoUrl ? (
                // A short-lived link to the resident's photo, never stored.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.photoUrl} alt={t('photoAlt')} style={{ maxWidth: '100%', borderRadius: 8 }} />
              ) : null}
              {open ? <p className="t-secondary">{t('frozen')}</p> : null}
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      <Dialog
        open={accepting}
        onClose={() => setAccepting(false)}
        title={t('acceptTitle')}
        description={t('acceptDescription')}
        onSubmit={() => validMoney(amount) && decide.mutate({ decision: 'accept', amount: amount.trim() })}
        footer={
          <>
            <Button onClick={() => setAccepting(false)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={decide.isPending} disabled={!validMoney(amount)}>
              {t('acceptAndCredit')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('creditEgp')} error={fieldError(decide.error, 'amount')}>
            {(p) => <Input {...p} inputMode="decimal" className="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <ErrorAlert error={decide.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={t('rejectTitle')}
        description={t('rejectDescription')}
        codes={REASON_CODES.invoiceDisputeReject}
        confirmLabel={t('reject')}
        danger
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => decide.mutate({ decision: 'reject', reasonCode })}
      />
    </>
  );
}

function Disputes() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const params = useSearchParams();
  const [view, setView] = useState<View>('open');
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const status = view === 'all' ? '' : view;
  const list = useCursorList(keys.disputes(status), (cursor) => fetchers.disputes(status, cursor), { enabled: allowed });
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
          options={[
            { value: 'open', label: t('view.open') },
            { value: 'accepted', label: t('view.accepted') },
            { value: 'rejected', label: t('view.rejected') },
            { value: 'all', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffDispute>
            rows={list.rows}
            rowKey={(d) => d.id}
            empty={t('none')}
            columns={[
              {
                key: 'i',
                header: t('col.invoice'),
                cell: (d) => (
                  <Button variant="text" className="table__link t-mono ltr" onClick={() => setOpen(d.id)}>
                    {d.invoiceNumber}
                  </Button>
                ),
              },
              {
                key: 'u',
                header: c('unit'),
                cell: (d) => (
                  <Link className="t-mono ltr" href={`/finance/units/${d.unitId}`}>
                    {d.unitCode}
                  </Link>
                ),
              },
              { key: 'r', header: c('reason'), cell: (d) => label(d.reasonCode) },
              { key: 'o', header: t('col.owed'), cell: (d) => f.money(d.outstanding) },
              { key: 's', header: c('status'), cell: (d) => <StatusBadge status={d.status} /> },
              { key: 'w', header: t('col.opened'), cell: (d) => <span title={f.dateTime(d.createdAt)}>{f.relative(d.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <DisputeDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** Invoice disputes (ADR 0048). */
export default function DisputesPage() {
  return (
    <Suspense>
      <Disputes />
    </Suspense>
  );
}
