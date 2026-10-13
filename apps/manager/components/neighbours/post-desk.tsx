'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, ConfirmDialog, DataTable, Dialog, Field, Input, ReasonCodeDialog, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type NeighbourClaim, type NeighbourPost } from '@/lib/queries';
import { personName, PersonLink } from './bits';
import { handoverBody, isAccountId, postActionsFor, type HandoverTo } from './logic';

/** Taking a post off its board, with a reason its author is told. */
export function RemovePost({ post }: { post: NeighbourPost }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const remove = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/posts/{id}/remove', { params: { path: { id: post.id } }, body: { reasonCode } })),
    {
      invalidate: [keys.neighbourPostsAll],
      onDone: () => {
        toast.show('The post was taken off its board.');
        setOpen(false);
      },
    },
  );
  if (!postActionsFor(post).remove) return null;
  const close = () => {
    setOpen(false);
    remove.reset();
  };
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Remove post
      </Button>
      <ReasonCodeDialog
        open={open}
        onClose={close}
        title="Remove this post?"
        description={
          post.authorSide === 'staff'
            ? 'It leaves its board for everyone. Claims still waiting on it are declined.'
            : 'It leaves its board for everyone, and its author is told that the management removed it. Claims still waiting on it are declined.'
        }
        codes={REASON_CODES.neighbourPostRemove}
        confirmLabel="Remove post"
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={(code) => remove.mutate(code)}
      />
    </>
  );
}

/**
 * A resident who came for the item without having claimed it in the app.
 * A role that reads residents picks one of the first hundred by name; any
 * role may paste the account's id instead (it is the last part of the
 * resident's page address). The API checks that it is an active resident
 * or family account (RECIPIENT_NOT_ELIGIBLE).
 */
function WalkInDialog({ onClose, onPick, pending, error }: { onClose: () => void; onPick: (accountId: string) => void; pending: boolean; error: unknown }) {
  const { can } = usePermissions();
  const mayList = can('residents.read');
  const [accountId, setAccountId] = useState('');
  const residents = useQuery({ queryKey: [...keys.residents, 'picker'], queryFn: () => fetchers.residents(undefined, 100), enabled: mayList });
  const list = [...(residents.data?.data ?? [])]
    .filter((r) => !r.erased && r.status === 'active')
    .sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? ''));
  const typed = accountId.trim();
  const ready = isAccountId(typed);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Hand over to someone else"
      description="For a resident who came to the office without a claim. The handover is recorded in their name, closes the post, and declines every claim still waiting."
      onSubmit={() => ready && onPick(typed)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!ready}>
            Record handover
          </Button>
        </>
      }
    >
      <div className="form">
        {mayList ? (
          <Field label="Resident" hint="From the first 100 residents. Not listed: paste their account ID below.">
            {(p) => (
              <Select {...p} value={list.some((r) => r.id === typed) ? typed : ''} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">{residents.isPending ? 'Loading…' : 'Select…'}</option>
                {list.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName ?? 'Unnamed account'}
                    {r.units?.length ? ` · ${r.units.map((u) => u.unitCode).join(', ')}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field
          label="Resident’s account ID"
          hint="The long id at the end of the resident’s page address, e.g. 0b1f6f0e-3c1d-4a52-9d57-0c7d5a3f9b11. An active resident or family account of this compound."
          error={fieldError(error, 'recipientAccountId') ?? (typed !== '' && !ready ? 'Not an account ID.' : undefined)}
        >
          {(p) => <Input {...p} className="t-mono" spellCheck={false} autoComplete="off" value={accountId} onChange={(e) => setAccountId(e.target.value)} />}
        </Field>
        <ErrorAlert error={error} />
      </div>
    </Dialog>
  );
}

type Open = { decline: NeighbourClaim } | { handTo: NeighbourClaim } | 'walk-in' | null;

/**
 * The claims on a found item and its handover (ADR 0042). The item is at
 * the office: a resident says it is theirs, the staff decide, and record
 * to whom it went. A handover closes the post and declines whoever else
 * was waiting. Shown for found items only: nothing else is held or claimed.
 */
export function Claims({ post }: { post: NeighbourPost }) {
  const toast = useToast();
  const may = postActionsFor(post);
  const [open, setOpen] = useState<Open>(null);
  const claims = useQuery({ queryKey: keys.neighbourClaims(post.id), queryFn: () => fetchers.neighbourClaims(post.id), enabled: may.claims });
  const refresh = { invalidate: [keys.neighbourPostsAll] };

  const decline = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/neighbours/claims/{id}/decline', { params: { path: { id } }, body: { reasonCode } })),
    {
      ...refresh,
      onDone: () => {
        toast.show('The claim was declined. Its claimant was told.');
        setOpen(null);
      },
    },
  );
  const handOver = useAction(
    async (to: HandoverTo) => {
      const body = handoverBody(to);
      if (!body) throw new Error('Nobody to hand it to.');
      return unwrap(api.POST('/api/v1/neighbours/posts/{id}/handover', { params: { path: { id: post.id } }, body }));
    },
    {
      ...refresh,
      onDone: () => {
        toast.show('The handover is recorded. The post is closed.');
        setOpen(null);
      },
    },
  );
  const close = () => {
    setOpen(null);
    decline.reset();
    handOver.reset();
  };

  if (!may.claims) return null;
  const declining = open && typeof open === 'object' && 'decline' in open ? open.decline : null;
  const handingTo = open && typeof open === 'object' && 'handTo' in open ? open.handTo : null;

  return (
    <>
      <Card flush>
        <CardHeader
          title="Claims"
          actions={
            may.handOver ? (
              <Button size="sm" onClick={() => setOpen('walk-in')}>
                Hand over to someone else
              </Button>
            ) : undefined
          }
        >
          <span className="t-secondary">Residents who say the item is theirs. Check with each what only its owner would know.</span>
        </CardHeader>
        <QueryState query={claims} rows={2}>
          <DataTable<NeighbourClaim>
            rows={claims.data?.data}
            rowKey={(c) => c.id}
            empty="Nobody has claimed it"
            columns={[
              {
                key: 'claimant',
                header: 'Claimant',
                cell: (c) => (
                  <span className="stack stack--sm">
                    <span className="table__primary">
                      <PersonLink person={c.claimant} />
                    </span>
                    <span className="t-secondary">{formatDateTime(c.createdAt)}</span>
                  </span>
                ),
              },
              {
                key: 'note',
                header: 'What they told the staff',
                cell: (c) => (c.note ? <span style={{ whiteSpace: 'pre-wrap' }}>{c.note}</span> : <span className="t-secondary">—</span>),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (c) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={c.status} />
                    {c.declineReason ? <span className="t-secondary">{humanize(c.declineReason)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (c) =>
                  c.status === 'pending' && may.decide ? (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <Button size="sm" variant="primary" onClick={() => setOpen({ handTo: c })}>
                        Hand over to this claimant
                      </Button>
                      <Button size="sm" onClick={() => setOpen({ decline: c })}>
                        Decline
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>

      <ReasonCodeDialog
        open={declining !== null}
        onClose={close}
        title={declining ? `Decline ${personName(declining.claimant)}’s claim?` : 'Decline the claim?'}
        description="The claimant is told the claim was declined. The item stays at the office and on the board."
        codes={REASON_CODES.neighbourClaimDecline}
        confirmLabel="Decline claim"
        danger
        pending={decline.isPending}
        error={<ErrorAlert error={decline.error} />}
        onConfirm={(reasonCode) => declining && decline.mutate({ id: declining.id, reasonCode })}
      />
      <ConfirmDialog
        open={handingTo !== null}
        onClose={close}
        title={handingTo ? `Hand the item to ${personName(handingTo.claimant)}?` : 'Hand the item over?'}
        description="Recorded once: to whom, by whom and when. The post closes, and every other claim still waiting is declined and its claimant told."
        confirmLabel="Record handover"
        pending={handOver.isPending}
        error={<ErrorAlert error={handOver.error} />}
        onConfirm={() => handingTo && handOver.mutate({ claimId: handingTo.id })}
      />
      {open === 'walk-in' ? (
        <WalkInDialog onClose={close} pending={handOver.isPending} error={handOver.error} onPick={(accountId) => handOver.mutate({ accountId })} />
      ) : null}
    </>
  );
}

/** To whom the item went, by whom and when. */
export function Handover({ post }: { post: NeighbourPost }) {
  const h = post.handover;
  if (!h) return null;
  return (
    <Card flush>
      <CardHeader title="Handed over" />
      <CardBody>
        <dl className="dl">
          <dt>To</dt>
          <dd>
            <PersonLink person={h.recipient} />
          </dd>
          <dt>How</dt>
          <dd>{h.claimId ? 'On their claim' : 'Came to the office without a claim'}</dd>
          <dt>By</dt>
          <dd>{personName(h.handedBy)}</dd>
          <dt>When</dt>
          <dd>{formatDateTime(h.handedAt)}</dd>
        </dl>
      </CardBody>
    </Card>
  );
}
