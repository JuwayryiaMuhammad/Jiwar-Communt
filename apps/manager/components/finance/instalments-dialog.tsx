'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type InvoiceDetail } from '@/lib/queries';
import ar from '@/messages/ar/fin-dialogs';
import en from '@/messages/en/fin-dialogs';
import { useFinanceT } from './codes';
import { instalmentsProblem, splitEqually } from './logic';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

/**
 * Split what an invoice owes into instalments (ADR 0048): monthly equal
 * parts to start from, each row editable. They must add up to exactly what
 * it owes now: a payment that lands first makes the API refuse, with the
 * new figure.
 */
export function InstalmentsDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const tc = useFinanceT();
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const router = useRouter();
  const [count, setCount] = useState(3);
  const [firstDue, setFirstDue] = useState(inDays(14));
  const [rows, setRows] = useState(() => splitEqually(invoice.outstanding, 3, inDays(14)));
  const resplit = (n: number, first: string) => setRows(splitEqually(invoice.outstanding, n, first));
  const problem = instalmentsProblem(tc, fmt, rows, invoice.outstanding);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/invoices/{id}/instalment-plan', {
          params: { path: { id: invoice.id } },
          body: { instalments: rows.map((r) => ({ dueOn: r.dueOn, amount: r.amount.trim() })) },
        }),
      ),
    {
      invalidate: [keys.invoicesAll],
      onDone: (plan) => {
        toast.show(t('split.done', { number: plan.number, count: plan.instalmentCount }));
        onClose();
        router.push(`/finance/instalments/${plan.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('split.title', { number: invoice.number })}
      description={t('split.description', { amount: fmt.money(invoice.outstanding) })}
      onSubmit={() => !problem && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={Boolean(problem)}>
            {t('split.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('split.count')}>
            {(p) => (
              <Select
                {...p}
                value={String(count)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setCount(n);
                  resplit(n, firstDue);
                }}
              >
                {Array.from({ length: 23 }, (_, i) => i + 2).map((n) => (
                  <option key={n} value={n}>
                    {t('split.countOption', { n })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('split.firstDue')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={firstDue}
                onChange={(e) => {
                  setFirstDue(e.target.value);
                  resplit(count, e.target.value);
                }}
              />
            )}
          </Field>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ gap: 16 }}>
            <Field label={t('split.rowDue', { n: i + 1 })} error={fieldError(save.error, `instalments.${i}.dueOn`)}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={r.dueOn}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))}
                />
              )}
            </Field>
            <Field label={t('amountEgp')} error={fieldError(save.error, `instalments.${i}.amount`)}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={r.amount}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
              )}
            </Field>
          </div>
        ))}
        {problem ? <Alert tone="warn">{problem}</Alert> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
