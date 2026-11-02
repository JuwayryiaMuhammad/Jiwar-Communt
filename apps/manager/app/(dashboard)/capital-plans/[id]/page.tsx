'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, Input, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RaiseApproval } from '@/components/governance/raise';
import { PLAN_STATUS_TEXT } from '@/components/reports/labels';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CapitalPlan } from '@/lib/queries';

type Line = CapitalPlan['lines'][number];

/**
 * A year's capital plan (ADR 0086): its lines while a draft — an asset of
 * the register or words of the staff, and an amount — then to the board as
 * one approval; once approved, nothing of it changes.
 */
export default function CapitalPlanPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('assets.manage');
  const plan = useQuery({ queryKey: keys.capitalPlan(id), queryFn: () => fetchers.capitalPlan(id), enabled: allowed });
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [raising, setRaising] = useState(false);
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/capital-plans/{id}/lines', {
          params: { path: { id } },
          body: { description: description.trim(), amount: amount.trim() },
        }),
      ),
    {
      invalidate: [keys.capitalPlansAll],
      onDone: () => {
        setDescription('');
        setAmount('');
      },
    },
  );
  const remove = useAction(
    (line: Line) =>
      unwrap(api.DELETE('/api/v1/maintenance/capital-plans/{id}/lines/{lineId}', { params: { path: { id, lineId: line.id } } })),
    { invalidate: [keys.capitalPlansAll] },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Capital plan" />
        <ForbiddenState />
      </>
    );
  const p = plan.data;
  const draft = p?.status === 'draft';
  return (
    <QueryState query={plan}>
      {p ? (
        <>
          <PageHeader
            title={`Capital plan ${p.year}`}
            description={`${p.lines.length} line(s), ${p.total} EGP in all.`}
            actions={
              <div className="row" style={{ gap: 8 }}>
                <Badge tone={p.status === 'approved' ? 'green' : 'beige'}>{PLAN_STATUS_TEXT[p.status]}</Badge>
                {p.approvalRequestId ? <Link href={`/governance/approvals/${p.approvalRequestId}`}>The board’s request</Link> : null}
                {draft && can('governance.approvals') ? (
                  <Button variant="primary" disabled={!p.lines.length} onClick={() => setRaising(true)}>
                    Submit to the board
                  </Button>
                ) : null}
              </div>
            }
          />
          {draft ? (
            <Card>
              <div className="form__row" style={{ padding: 12 }}>
                <Field label="What" error={fieldError(add.error, 'description')}>
                  {(f) => <Input {...f} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />}
                </Field>
                <Field label="Amount (EGP)" error={fieldError(add.error, 'amount')}>
                  {(f) => <Input {...f} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />}
                </Field>
                <Button loading={add.isPending} disabled={!description.trim() || !amount.trim()} onClick={() => add.mutate(undefined)}>
                  Add a line
                </Button>
              </div>
              <ErrorAlert error={add.error ?? remove.error} />
            </Card>
          ) : null}
          <Card flush>
            <DataTable<Line>
              rows={p.lines}
              rowKey={(l) => l.id}
              empty="No line yet"
              columns={[
                { key: 'asset', header: 'Asset', cell: (l) => (l.assetId ? <Link href={`/assets/${l.assetId}`}>{l.assetCode}</Link> : '—') },
                { key: 'type', header: 'Type', cell: (l) => l.assetTypeKey ?? '—' },
                { key: 'what', header: 'What', cell: (l) => l.description },
                { key: 'amount', header: 'Amount (EGP)', cell: (l) => l.amount },
                { key: 'source', header: 'From', cell: (l) => (l.source === 'computed' ? 'The register' : 'Added') },
                {
                  key: 'act',
                  header: '',
                  cell: (l) =>
                    draft ? (
                      <Button size="sm" onClick={() => remove.mutate(l)}>
                        Remove
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Card>
          {raising ? <RaiseApproval capitalPlanId={p.id} onClose={() => setRaising(false)} /> : null}
        </>
      ) : null}
    </QueryState>
  );
}
