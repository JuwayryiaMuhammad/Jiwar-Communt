'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Button, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { api } from '@/lib/api';
import { keys, type InvoiceDetail } from '@/lib/queries';
import { instalmentsProblem, splitEqually } from './logic';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

/**
 * Split what an invoice owes into instalments (ADR 0048): monthly equal
 * parts to start from, each row editable. They must add up to exactly what
 * it owes now: a payment that lands first makes the API refuse, with the
 * new figure.
 */
export function InstalmentsDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [count, setCount] = useState(3);
  const [firstDue, setFirstDue] = useState(inDays(14));
  const [rows, setRows] = useState(() => splitEqually(invoice.outstanding, 3, inDays(14)));
  const resplit = (n: number, first: string) => setRows(splitEqually(invoice.outstanding, n, first));
  const problem = instalmentsProblem(rows, invoice.outstanding);
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
        toast.show(`Plan ${plan.number}: ${plan.instalmentCount} instalments. The unit was told once.`);
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
      title={`Split ${invoice.number} into instalments`}
      description={`It owes ${egp(invoice.outstanding)}. A credit note closes it; each instalment is an invoice of its own, paid and reminded like any other.`}
      onSubmit={() => !problem && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={Boolean(problem)}>
            Split
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="row" style={{ gap: 16 }}>
          <Field label="Instalments">
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
                    {n}, monthly
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="First due">
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
            <Field label={`Instalment ${i + 1} due`} error={fieldError(save.error, `instalments.${i}.dueOn`)}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={r.dueOn}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueOn: e.target.value } : x)))}
                />
              )}
            </Field>
            <Field label="Amount, EGP" error={fieldError(save.error, `instalments.${i}.amount`)}>
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
