'use client';

import { fieldError, unwrap } from '@jiwar/api';
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
  Segmented,
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type VendorInvoice } from '@/lib/queries';
import ar from '@/messages/ar/fin-payables';
import en from '@/messages/en/fin-payables';

type Status = VendorInvoice['status'] | '';
const today = () => new Date().toLocaleDateString('en-CA');
const TAX_CODES = ['zero', 'exempt', 'vat_14'] as const;
const WITHHOLDING = ['supplies', 'services', 'professional', 'exempt'] as const;
type Withholding = (typeof WITHHOLDING)[number];
type TaxCode = (typeof TAX_CODES)[number];

/** A vendor's invoice, against a contract (or one of its payments) or a fulfilled purchase request. */
function RecordInvoice({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [withholding, setWithholding] = useState<'' | Withholding>('');
  const [against, setAgainst] = useState<'contract' | 'purchase'>('contract');
  const [sourceId, setSourceId] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [vendorNumber, setVendorNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState(today());
  const [dueOn, setDueOn] = useState(today());
  const [lines, setLines] = useState<{ description: string; amount: string; taxCode: TaxCode }[]>([{ description: '', amount: '', taxCode: 'zero' }]);
  const [file, setFile] = useState<string | null>(null);
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/finance/vendor-invoices', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            vendorNumber: vendorNumber.trim(),
            issuedOn,
            dueOn,
            invoiceFileId: file ?? '',
            ...(withholding ? { withholdingCategory: withholding } : {}),
            ...(against === 'contract'
              ? { contractId: sourceId.trim(), ...(paymentId.trim() ? { contractPaymentId: paymentId.trim() } : {}) }
              : { purchaseRequestId: sourceId.trim() }),
            lines: lines.map((l) => ({
              description: l.description.trim(),
              amount: l.amount.trim(),
              taxCode: l.taxCode,
            })),
          },
        }),
      ),
    {
      invalidate: [keys.payablesAll],
      onDone: (i) => {
        toast.show(t('record.done', { number: i.number }));
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(record.error, f);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('record.title')}
      description={t('record.description')}
      onSubmit={() => record.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            loading={record.isPending}
            disabled={!sourceId.trim() || !vendorNumber.trim() || !file || lines.some((l) => !l.description.trim() || !l.amount.trim())}
          >
            {t('record.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<'contract' | 'purchase'>
          label={t('record.against')}
          value={against}
          onChange={setAgainst}
          options={[
            { value: 'contract', label: t('record.contract') },
            { value: 'purchase', label: t('record.purchase') },
          ]}
        />
        <Field
          label={against === 'contract' ? t('record.contractId') : t('record.purchaseId')}
          error={err(against === 'contract' ? 'contractId' : 'purchaseRequestId')}
        >
          {(p) => <Input {...p} dir="ltr" value={sourceId} onChange={(e) => setSourceId(e.target.value)} />}
        </Field>
        {against === 'contract' ? (
          <Field label={t('record.paymentId')} error={err('contractPaymentId')}>
            {(p) => <Input {...p} dir="ltr" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} />}
          </Field>
        ) : null}
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('record.vendorNumber')} error={err('vendorNumber')}>
            {(p) => <Input {...p} maxLength={60} value={vendorNumber} onChange={(e) => setVendorNumber(e.target.value)} />}
          </Field>
          <Field label={t('record.dated')} error={err('issuedOn')}>
            {(p) => <Input {...p} type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />}
          </Field>
          <Field label={t('record.due')} error={err('dueOn')}>
            {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
          </Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label={t('record.line', { n: i + 1 })} error={err(`lines.${i}.description`)}>
              {(p) => (
                <Input
                  {...p}
                  maxLength={200}
                  value={l.description}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
              )}
            </Field>
            <Field label={t('record.egp')} error={err(`lines.${i}.amount`)}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={l.amount}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
              )}
            </Field>
            <Field label={t('record.tax')}>
              {(p) => (
                <Select
                  {...p}
                  value={l.taxCode}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, taxCode: e.target.value as TaxCode } : x)))}
                >
                  {TAX_CODES.map((v) => (
                    <option key={v} value={v}>
                      {t(`tax.${v}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ))}
        <Field label={t('record.withholding')} error={err('withholdingCategory')} hint={t('record.withholdingHint')}>
          {(p) => (
            <Select {...p} value={withholding} onChange={(e) => setWithholding(e.target.value as '' | Withholding)}>
              <option value="">{t('record.withholdingDefault')}</option>
              {WITHHOLDING.map((w) => (
                <option key={w} value={w}>
                  {label(w)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button size="sm" onClick={() => setLines([...lines, { description: '', amount: '', taxCode: 'zero' }])} disabled={lines.length >= 50}>
          {t('record.addLine')}
        </Button>
        {file ? <p className="t-secondary">{t('record.attached')}</p> : null}
        <FileUpload purpose="expense_invoice" label={t('record.attach')} onUploaded={setFile} disabled={file !== null} />
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

/** Payables (ADR 0089): vendors' invoices and the payment schedule. */
export default function PayablesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const allowed = can('finance.payables') || can('finance.payables_approve');
  const [status, setStatus] = useState<Status>('received');
  const [recording, setRecording] = useState(false);
  const filters = { status };
  const list = useCursorList(keys.vendorInvoices(filters), (cursor) => fetchers.vendorInvoices(filters, cursor), { enabled: allowed });
  const schedule = useQuery({
    queryKey: keys.paymentSchedule('', ''),
    queryFn: () => fetchers.paymentSchedule('', ''),
    enabled: allowed,
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
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Link href="/finance/payables/contracts">{t('contractsLink')}</Link>{' '}
            {can('finance.payables') ? (
              <Button variant="primary" onClick={() => setRecording(true)}>
                {t('recordInvoice')}
              </Button>
            ) : null}
          </>
        }
      />
      {recording ? <RecordInvoice onClose={() => setRecording(false)} /> : null}
      <div className="toolbar">
        <Segmented<Status>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'received', label: t('view.received') },
            { value: 'approved', label: t('view.approved') },
            { value: 'paid', label: t('view.paid') },
            { value: '', label: c('all') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<VendorInvoice>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              {
                key: 'n',
                header: t('invoice'),
                cell: (r) => (
                  <Link className="ltr" href={`/finance/payables/${r.id}`}>{`${r.number} · ${r.vendorNumber}`}</Link>
                ),
              },
              { key: 't', header: c('total'), cell: (r) => f.money(r.total) },
              { key: 'd', header: t('due'), cell: (r) => f.day(r.dueOn) },
              { key: 's', header: c('status'), cell: (r) => label(r.status) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <Card>
        <SectionHeader
          title={t('schedule.title')}
          description={
            schedule.data
              ? t('schedule.summary', {
                  from: f.day(schedule.data.from),
                  to: f.day(schedule.data.to),
                  invoices: f.money(schedule.data.totals.invoices),
                  commitments: f.money(schedule.data.totals.commitments),
                  count: f.number(schedule.data.overdue.count),
                  amount: f.money(schedule.data.overdue.amount),
                })
              : undefined
          }
        />
        <QueryState query={schedule}>
          <DataTable
            rows={schedule.data?.rows ?? []}
            rowKey={(r) => `${r.kind}-${r.id}`}
            empty={t('schedule.empty')}
            columns={[
              { key: 'd', header: t('schedule.day'), cell: (r) => f.day(r.day) },
              {
                key: 'k',
                header: t('schedule.what'),
                cell: (r) =>
                  r.kind === 'invoice' ? t('schedule.invoice', { reference: r.reference }) : t('schedule.committed', { source: label(r.source) }),
              },
              { key: 'v', header: t('schedule.vendor'), cell: (r) => r.vendorName ?? '—' },
              { key: 'a', header: c('amount'), cell: (r) => f.money(r.amount) },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
