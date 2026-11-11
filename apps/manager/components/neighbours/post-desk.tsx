'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  Input,
  ReasonCodeDialog,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ResidentPicker } from '@/components/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type NeighbourClaim, type NeighbourPost } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-posts';
import en from '@/messages/en/neighbours-posts';
import { PersonLink } from './bits';
import { handoverBody, isAccountId, postActionsFor, type HandoverTo } from './logic';
import { useWho } from './who';

/** Taking a post off its board, with a reason its author is told. */
export function RemovePost({ post }: { post: NeighbourPost }) {
  const t = useT(en, ar);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const remove = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/posts/{id}/remove', { params: { path: { id: post.id } }, body: { reasonCode } })),
    {
      invalidate: [keys.neighbourPostsAll],
      onDone: () => {
        toast.show(t('remove.done'));
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
        {t('remove.button')}
      </Button>
      <ReasonCodeDialog
        open={open}
        onClose={close}
        title={t('remove.title')}
        description={post.authorSide === 'staff' ? t('remove.descriptionStaff') : t('remove.description')}
        codes={REASON_CODES.neighbourPostRemove}
        confirmLabel={t('remove.button')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const who = useWho();
  const { can } = usePermissions();
  const mayList = can('residents.read');
  const [accountId, setAccountId] = useState('');
  const typed = accountId.trim();
  const ready = isAccountId(typed);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('walkIn.title')}
      description={t('walkIn.description')}
      onSubmit={() => ready && onPick(typed)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!ready}>
            {t('walkIn.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        {mayList ? (
          <Field label={t('walkIn.resident')} hint={t('walkIn.residentHint')}>
            {(p) => (
              <ResidentPicker {...p} placeholder={c('select')} value={isAccountId(typed) ? typed : ''} onChange={(id) => setAccountId(id)} />
            )}
          </Field>
        ) : null}
        <Field
          label={t('walkIn.accountId')}
          hint={t('walkIn.accountIdHint')}
          error={fieldError(error, 'recipientAccountId') ?? (typed !== '' && !ready ? t('walkIn.notAnId') : undefined)}
        >
          {(p) => <Input {...p} className="t-mono ltr" spellCheck={false} autoComplete="off" value={accountId} onChange={(e) => setAccountId(e.target.value)} />}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const who = useWho();
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
        toast.show(t('claims.declined'));
        setOpen(null);
      },
    },
  );
  const handOver = useAction(
    async (to: HandoverTo) => {
      const body = handoverBody(to);
      if (!body) throw new Error(t('walkIn.noOne'));
      return unwrap(api.POST('/api/v1/neighbours/posts/{id}/handover', { params: { path: { id: post.id } }, body }));
    },
    {
      ...refresh,
      onDone: () => {
        toast.show(t('claims.handed'));
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
          title={t('claims.title')}
          actions={
            may.handOver ? (
              <Button size="sm" onClick={() => setOpen('walk-in')}>
                {t('walkIn.title')}
              </Button>
            ) : undefined
          }
        >
          <span className="t-secondary">{t('claims.hint')}</span>
        </CardHeader>
        <QueryState query={claims} rows={2}>
          <DataTable<NeighbourClaim>
            rows={claims.data?.data}
            rowKey={(cl) => cl.id}
            empty={t('claims.empty')}
            columns={[
              {
                key: 'claimant',
                header: t('claims.claimant'),
                cell: (cl) => (
                  <span className="stack stack--sm">
                    <span className="table__primary">
                      <PersonLink person={cl.claimant} />
                    </span>
                    <span className="t-secondary">{f.dateTime(cl.createdAt)}</span>
                  </span>
                ),
              },
              {
                key: 'note',
                header: t('claims.told'),
                cell: (cl) => (cl.note ? <span style={{ whiteSpace: 'pre-wrap' }}>{cl.note}</span> : <span className="t-secondary">—</span>),
              },
              {
                key: 'status',
                header: c('status'),
                cell: (cl) => (
                  <span className="stack stack--sm">
                    <StatusBadge status={cl.status} />
                    {cl.declineReason ? <span className="t-secondary">{label(cl.declineReason)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (cl) =>
                  cl.status === 'pending' && may.decide ? (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <Button size="sm" variant="primary" onClick={() => setOpen({ handTo: cl })}>
                        {t('claims.handTo')}
                      </Button>
                      <Button size="sm" onClick={() => setOpen({ decline: cl })}>
                        {c('decline')}
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
        title={declining ? t('decline.title', { name: who.person(declining.claimant) }) : t('decline.titleNone')}
        description={t('decline.description')}
        codes={REASON_CODES.neighbourClaimDecline}
        confirmLabel={t('decline.confirm')}
        danger
        pending={decline.isPending}
        error={<ErrorAlert error={decline.error} />}
        onConfirm={(reasonCode) => declining && decline.mutate({ id: declining.id, reasonCode })}
      />
      <ConfirmDialog
        open={handingTo !== null}
        onClose={close}
        title={handingTo ? t('handTo.title', { name: who.person(handingTo.claimant) }) : t('handTo.titleNone')}
        description={t('handTo.description')}
        confirmLabel={t('handTo.confirm')}
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
  const t = useT(en, ar);
  const f = useFormat();
  const who = useWho();
  const h = post.handover;
  if (!h) return null;
  return (
    <Card flush>
      <CardHeader title={t('handover.title')} />
      <CardBody>
        <dl className="dl">
          <dt>{t('handover.to')}</dt>
          <dd>
            <PersonLink person={h.recipient} />
          </dd>
          <dt>{t('handover.how')}</dt>
          <dd>{h.claimId ? t('handover.onClaim') : t('handover.walkIn')}</dd>
          <dt>{t('handover.by')}</dt>
          <dd>{who.person(h.handedBy)}</dd>
          <dt>{t('handover.when')}</dt>
          <dd>{f.dateTime(h.handedAt)}</dd>
        </dl>
      </CardBody>
    </Card>
  );
}
