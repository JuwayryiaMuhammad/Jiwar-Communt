'use client';

import { humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Field, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Tender } from '@/lib/queries';

type Bid = Tender['bids'][number];

/**
 * One tender (ADR 0088): its invitations and bid links (a link is shown
 * once), the bids — who and when, sealed until opened — the two-person
 * opening and the award.
 */
export default function TenderPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = usePermissions();
  const q = useQuery({ queryKey: keys.tender(id), queryFn: () => fetchers.tender(id) });
  const [company, setCompany] = useState('');
  const [shownLink, setShownLink] = useState<string | null>(null);
  const invalidate = [keys.tender(id), keys.tendersAll];
  const publish = useAction(() => unwrap(api.POST('/api/v1/staff/tenders/{id}/publish', { params: { path: { id } } })), {
    invalidate,
    onDone: () => toast.show('Published: bids are taken until the deadline.'),
  });
  const open = useAction(() => unwrap(api.POST('/api/v1/staff/tenders/{id}/opening', { params: { path: { id } } })), {
    invalidate,
    onDone: (t) =>
      toast.show(t.status === 'opened' ? 'Opened: the bids are unsealed.' : 'Opening begun: a second person confirms it.'),
  });
  const invite = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/tenders/{id}/invitations', {
          params: { path: { id } },
          body: { companyName: company.trim() },
        }),
      ),
    {
      invalidate,
      onDone: (r) => {
        setShownLink('url' in r ? (r.url as string) : null);
        setCompany('');
      },
    },
  );
  return (
    <QueryState query={q}>
      {q.data ? (
        <>
          <PageHeader
            title={`${q.data.reference} · ${q.data.title}`}
            description={`${humanize(q.data.status)} · bids until ${new Date(q.data.bidsDueAt).toLocaleString()}`}
            actions={
              <>
                {q.data.status === 'draft' && can('tenders.manage') ? (
                  <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate()}>
                    Publish
                  </Button>
                ) : null}
                {(q.data.status === 'open' || q.data.status === 'opening') && can('tenders.open') ? (
                  <Button variant="primary" loading={open.isPending} onClick={() => open.mutate()}>
                    {q.data.status === 'opening' ? 'Confirm the opening' : 'Open the bids'}
                  </Button>
                ) : null}
              </>
            }
          />
          <ErrorAlert error={publish.error ?? open.error ?? invite.error} />
          <Card>
            <CardHeader title="Invited" />
            <DataTable<Tender['invitations'][number]>
              rows={q.data.invitations}
              rowKey={(i) => i.id}
              empty="Nobody invited yet"
              columns={[
                { key: 'n', header: 'Who', cell: (i) => i.name ?? '—' },
                { key: 'k', header: 'How', cell: (i) => (i.kind === 'link' ? 'Bid link' : 'Registered vendor') },
                { key: 'r', header: 'Revoked', cell: (i) => (i.revokedAt ? new Date(i.revokedAt).toLocaleString() : '—') },
              ]}
            />
            {can('tenders.manage') && (q.data.status === 'draft' || q.data.status === 'open') ? (
              <div className="form__row">
                <Field label="A company that is not registered" hint="Its bid link is shown once.">
                  {(p) => <Input {...p} value={company} onChange={(e) => setCompany(e.target.value)} />}
                </Field>
                <Button loading={invite.isPending} disabled={company.trim().length < 2} onClick={() => invite.mutate()}>
                  Make a bid link
                </Button>
              </div>
            ) : null}
            {shownLink ? <p className="hint">Send this link now; it is not shown again: {shownLink}</p> : null}
          </Card>
          <Card flush>
            <CardHeader title="Bids" />
            <DataTable<Bid>
              rows={q.data.bids}
              rowKey={(b) => b.id}
              empty="No bid yet"
              columns={[
                { key: 'w', header: 'Bidder', cell: (b) => b.bidder ?? '—' },
                { key: 't', header: 'Sent', cell: (b) => new Date(b.submittedAt).toLocaleString() },
                { key: 'a', header: 'Amount', cell: (b) => (b.sealed ? 'Sealed' : `${b.amount} EGP`) },
                { key: 'x', header: 'Withdrawn', cell: (b) => (b.withdrawnAt ? 'Yes' : '—') },
              ]}
            />
          </Card>
        </>
      ) : null}
    </QueryState>
  );
}
