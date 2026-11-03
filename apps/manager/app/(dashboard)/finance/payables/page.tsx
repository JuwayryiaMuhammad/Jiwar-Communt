'use client';

import { fieldError, formatDate, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type VendorInvoice } from '@/lib/queries';

type Status = VendorInvoice['status'] | '';
const today = () => new Date().toLocaleDateString('en-CA');
const TAX_TEXT: Record<string, string> = { zero: 'No tax', exempt: 'Exempt', vat_14: 'VAT 14%' };

/** A vendor's invoice, against a contract (or one of its payments) or a fulfilled purchase request. */
function RecordInvoice({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [against, setAgainst] = useState<'contract' | 'purchase'>('contract');
  const [sourceId, setSourceId] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [vendorNumber, setVendorNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState(today());
  const [dueOn, setDueOn] = useState(today());
  const [lines, setLines] = useState([{ description: '', amount: '', taxCode: 'zero' }]);
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
            ...(against === 'contract'
              ? { contractId: sourceId.trim(), ...(paymentId.trim() ? { contractPaymentId: paymentId.trim() } : {}) }
              : { purchaseRequestId: sourceId.trim() }),
            lines: lines.map((l) => ({
              description: l.description.trim(),
              amount: l.amount.trim(),
              taxCode: l.taxCode as 'zero' | 'exempt' | 'vat_14',
            })),
          },
        }),
      ),
    {
      invalidate: [keys.payablesAll],
      onDone: (i) => {
        toast.show(`Recorded as ${i.number}. The approvers were told.`);
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
      title="Record a vendor’s invoice"
      description="Someone else approves it against the budget line; its number is taken once per vendor."
      onSubmit={() => record.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={record.isPending}
            disabled={!sourceId.trim() || !vendorNumber.trim() || !file || lines.some((l) => !l.description.trim() || !l.amount.trim())}
          >
            Record
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<'contract' | 'purchase'>
          label="Against"
          value={against}
          onChange={setAgainst}
          options={[
            { value: 'contract', label: 'A contract' },
            { value: 'purchase', label: 'A purchase request' },
          ]}
        />
        <Field label={against === 'contract' ? 'Contract id' : 'Purchase request id'} error={err(against === 'contract' ? 'contractId' : 'purchaseRequestId')}>
          {(p) => <Input {...p} value={sourceId} onChange={(e) => setSourceId(e.target.value)} />}
        </Field>
        {against === 'contract' ? (
          <Field label="Payment of its schedule (optional)" error={err('contractPaymentId')}>
            {(p) => <Input {...p} value={paymentId} onChange={(e) => setPaymentId(e.target.value)} />}
          </Field>
        ) : null}
        <div className="row" style={{ gap: 16 }}>
          <Field label="The vendor’s invoice number" error={err('vendorNumber')}>
            {(p) => <Input {...p} maxLength={60} value={vendorNumber} onChange={(e) => setVendorNumber(e.target.value)} />}
          </Field>
          <Field label="Dated" error={err('issuedOn')}>
            {(p) => <Input {...p} type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />}
          </Field>
          <Field label="Due" error={err('dueOn')}>
            {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
          </Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label={`Line ${i + 1}`} error={err(`lines.${i}.description`)}>
              {(p) => (
                <Input
                  {...p}
                  maxLength={200}
                  value={l.description}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
              )}
            </Field>
            <Field label="EGP" error={err(`lines.${i}.amount`)}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={l.amount}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
              )}
            </Field>
            <Field label="Tax">
              {(p) => (
                <Select
                  {...p}
                  value={l.taxCode}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, taxCode: e.target.value } : x)))}
                >
                  {Object.entries(TAX_TEXT).map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ))}
        <Button size="sm" onClick={() => setLines([...lines, { description: '', amount: '', taxCode: 'zero' }])} disabled={lines.length >= 50}>
          Add a line
        </Button>
        {file ? <p className="t-secondary">The scan is attached.</p> : null}
        <FileUpload purpose="expense_invoice" label="Attach the invoice’s scan" onUploaded={setFile} disabled={file !== null} />
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

/** Payables (ADR 0089): vendors' invoices and the payment schedule. */
export default function PayablesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.payables') || can('finance.payables_approve');
  const [status, setStatus] = useState<Status>('received');
  const [recording, setRecording] = useState(false);
  const filters = { status };
  const list = useCursorList(keys.vendorInvoices(filters), (c) => fetchers.vendorInvoices(filters, c), { enabled: allowed });
  const schedule = useQuery({
    queryKey: keys.paymentSchedule('', ''),
    queryFn: () => fetchers.paymentSchedule('', ''),
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Payables" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Payables"
        description="What vendors bill the compound: approved against the budget line by someone who did not record it, then paid once."
        actions={
          <>
            <Link href="/finance/payables/contracts">Advances, retentions and guarantees</Link>{' '}
            {can('finance.payables') ? (
              <Button variant="primary" onClick={() => setRecording(true)}>
                Record an invoice
              </Button>
            ) : null}
          </>
        }
      />
      {recording ? <RecordInvoice onClose={() => setRecording(false)} /> : null}
      <div className="toolbar">
        <Segmented<Status>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'received', label: 'To approve' },
            { value: 'approved', label: 'To pay' },
            { value: 'paid', label: 'Paid' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<VendorInvoice>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty="No vendor invoice"
            columns={[
              { key: 'n', header: 'Invoice', cell: (r) => <Link href={`/finance/payables/${r.id}`}>{`${r.number} · ${r.vendorNumber}`}</Link> },
              { key: 't', header: 'Total', cell: (r) => egp(r.total) },
              { key: 'd', header: 'Due', cell: (r) => formatDate(r.dueOn) },
              { key: 's', header: 'Status', cell: (r) => humanize(r.status) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <Card>
        <CardHeader
          title="Next month’s payments"
          description={
            schedule.data
              ? `${formatDate(schedule.data.from)} – ${formatDate(schedule.data.to)}: ${egp(schedule.data.totals.invoices)} approved to pay, ${egp(schedule.data.totals.commitments)} committed. Overdue: ${schedule.data.overdue.count} (${egp(schedule.data.overdue.amount)}).`
              : undefined
          }
        />
        <QueryState query={schedule}>
          <DataTable
            rows={schedule.data?.rows ?? []}
            rowKey={(r) => `${r.kind}-${r.id}`}
            empty="Nothing due"
            columns={[
              { key: 'd', header: 'Day', cell: (r) => formatDate(r.day) },
              { key: 'k', header: 'What', cell: (r) => (r.kind === 'invoice' ? `Invoice ${r.reference}` : `Committed (${humanize(r.source)})`) },
              { key: 'v', header: 'Vendor', cell: (r) => r.vendorName ?? '—' },
              { key: 'a', header: 'Amount', cell: (r) => egp(r.amount) },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
