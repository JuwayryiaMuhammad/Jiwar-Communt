'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, CardHeader, DataTable, Dialog, Field, Input, ReasonCodeDialog, Textarea, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AssetTimelineEntry, type WarrantyClaim } from '@/lib/queries';

const KIND_TEXT: Record<string, string> = {
  asset_event: 'Asset',
  ticket_opened: 'Ticket opened',
  ticket_completed: 'Work done',
  ticket_closed: 'Ticket closed',
  part_issued: 'Part issued',
  part_returned: 'Part returned',
  cost: 'Cost',
  warranty_claim_opened: 'Warranty claim',
  warranty_claim_decided: 'Claim decided',
};

const detail = (e: AssetTimelineEntry): string =>
  [
    e.code ? humanize(e.code) : null,
    e.fromValue || e.toValue ? `${e.fromValue ?? '—'} → ${e.toValue ?? '—'}` : null,
    e.reasonCode ? humanize(e.reasonCode) : null,
    e.amount ? `${e.amount} EGP` : null,
    e.quantity ? `× ${e.quantity}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** An asset's whole history (ADR 0076): events, tickets, parts, costs, warranty claims. */
export function AssetTimeline({ id }: { id: string }) {
  const list = useCursorList(keys.assetTimeline(id), (c) => fetchers.assetTimeline(id, c));
  return (
    <Card flush>
      <CardHeader title="Timeline" />
      <QueryState query={list}>
        <DataTable<AssetTimelineEntry>
          rows={list.rows}
          rowKey={(e) => `${e.kind}:${e.id}`}
          empty="Nothing yet"
          columns={[
            { key: 'when', header: 'When', width: 170, cell: (e) => formatDateTime(e.at) },
            { key: 'kind', header: 'What', cell: (e) => KIND_TEXT[e.kind] ?? humanize(e.kind) },
            { key: 'detail', header: 'Detail', cell: (e) => detail(e) || '—' },
            {
              key: 'ticket',
              header: 'Ticket',
              cell: (e) =>
                e.ticketId ? (
                  <Link className="table__link t-mono" href={`/maintenance/${e.ticketId}`}>
                    {e.ticketNumber ?? 'Open'}
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
        toast.show('The claim is open.');
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
        toast.show('The claim is accepted.');
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
        title="Warranty claims"
        actions={
          underWarranty ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              New claim
            </Button>
          ) : null
        }
      />
      <QueryState query={list}>
        <DataTable<WarrantyClaim>
          rows={list.rows}
          rowKey={(c) => c.id}
          empty="No claim yet"
          columns={[
            { key: 'opened', header: 'Opened', width: 170, cell: (c) => formatDateTime(c.openedAt) },
            { key: 'what', header: 'What failed', cell: (c) => c.description },
            { key: 'ref', header: 'Reference', cell: (c) => c.reference ?? '—' },
            {
              key: 'status',
              header: 'Status',
              cell: (c) => (
                <span className="row" style={{ gap: 6 }}>
                  <Badge>{humanize(c.status)}</Badge>
                  {c.reasonCode ? <span className="t-secondary">{humanize(c.reasonCode)}</span> : null}
                  {c.recoveredAmount ? <span className="t-secondary">{c.recoveredAmount} EGP</span> : null}
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
                      Accepted
                    </Button>
                    <Button size="sm" onClick={() => setDeciding({ claim: c, how: 'reject' })}>
                      Rejected
                    </Button>
                    <Button size="sm" onClick={() => setDeciding({ claim: c, how: 'withdraw' })}>
                      Withdraw
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
        title="Claim under the warranty"
        description="While the warranty runs. What failed is plain data for the warrantor."
        onSubmit={() => description.trim() && create.mutate()}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!description.trim()}>
              Open claim
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="What failed">
            {(p) => <Textarea {...p} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <ErrorAlert error={create.error} />
        </div>
      </Dialog>
      <Dialog
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title="The warrantor accepted it"
        onSubmit={() => accepting && accept.mutate(accepting.id)}
        footer={
          <>
            <Button onClick={() => setAccepting(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={accept.isPending}>
              Record
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="What it paid or covered (EGP)" hint="Optional.">
            {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <ErrorAlert error={accept.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding?.how === 'reject' ? 'The warrantor rejected it' : 'Withdraw the claim'}
        codes={deciding?.how === 'reject' ? REASON_CODES.warrantyClaimReject : REASON_CODES.warrantyClaimWithdraw}
        confirmLabel={deciding?.how === 'reject' ? 'Record' : 'Withdraw'}
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => deciding && decide.mutate({ id: deciding.claim.id, how: deciding.how, reasonCode })}
      />
    </Card>
  );
}
