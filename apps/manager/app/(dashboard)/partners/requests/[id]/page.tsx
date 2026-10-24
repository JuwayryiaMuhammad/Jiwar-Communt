'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { fromLocalInput } from '@/components/facilities/logic';
import { PRICE_UNIT_TEXT, REQUEST_STATUS_TEXT, relayActions, requestTitle } from '@/components/partners/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerRequest } from '@/lib/queries';

type Answer = { kind: 'accept'; staffCount: number } | { kind: 'propose'; startsAt: string; endsAt: string; staffCount: number };

function AnswerDialog({ request, kind, onClose }: { request: PartnerRequest; kind: Answer['kind']; onClose: () => void }) {
  const toast = useToast();
  const [staffCount, setStaffCount] = useState('1');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const send = useAction(
    () =>
      unwrap(
        kind === 'accept'
          ? api.POST('/api/v1/staff/partner-requests/{id}/accept', {
              params: { path: { id: request.id } },
              body: { staffCount: Number(staffCount) },
            })
          : api.POST('/api/v1/staff/partner-requests/{id}/propose', {
              params: { path: { id: request.id } },
              body: {
                windowStartsAt: fromLocalInput(startsAt) ?? startsAt,
                windowEndsAt: fromLocalInput(endsAt) ?? endsAt,
                staffCount: Number(staffCount),
              },
            }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: () => {
        toast.show(kind === 'accept' ? 'Accepted for the partner. The resident was told.' : 'Proposed for the partner. The resident accepts or declines.');
        onClose();
      },
    },
  );
  const count = Number(staffCount);
  const ready = Number.isInteger(count) && count >= 1 && count <= 5 && (kind === 'accept' || (fromLocalInput(startsAt) && fromLocalInput(endsAt)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'accept' ? 'Accept for the partner' : 'Propose another time'}
      description={
        kind === 'accept'
          ? 'As the partner told you. When the request asked for it, its staff get a gate pass for the window, in the resident’s name.'
          : 'From 15 minutes to 14 days ahead, 30 minutes to 8 hours long.'
      }
      onSubmit={() => ready && send.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={send.isPending} disabled={!ready}>
            {kind === 'accept' ? 'Accept' : 'Propose'}
          </Button>
        </>
      }
    >
      <div className="form">
        {kind === 'propose' ? (
          <>
            <Field label="From" error={fieldError(send.error, 'windowStartsAt')}>
              {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
            </Field>
            <Field label="To" error={fieldError(send.error, 'windowEndsAt')}>
              {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Field label="How many of its staff come" hint="1 to 5: the gate lets in as many." error={fieldError(send.error, 'staffCount')}>
          {(p) => <Input {...p} type="number" min={1} max={5} value={staffCount} onChange={(e) => setStaffCount(e.target.value)} />}
        </Field>
        <ErrorAlert error={send.error} />
      </div>
    </Dialog>
  );
}

/** One request to a partner (ADR 0060), as its partner sees it, and the relay's answers. */
export default function PartnerRequestPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('partners.manage');
  const request = useQuery({ queryKey: keys.partnerRequest(id), queryFn: () => fetchers.partnerRequest(id), enabled: allowed });
  const [answering, setAnswering] = useState<Answer['kind'] | null>(null);
  const [declining, setDeclining] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const act = useAction(
    (body: { action: 'decline' | 'cancel' | 'done'; reasonCode?: string }) =>
      unwrap(
        body.action === 'decline'
          ? api.POST('/api/v1/staff/partner-requests/{id}/decline', { params: { path: { id } }, body: { reasonCode: body.reasonCode! } })
          : body.action === 'cancel'
            ? api.POST('/api/v1/staff/partner-requests/{id}/cancel', { params: { path: { id } }, body: { reasonCode: body.reasonCode! } })
            : api.POST('/api/v1/staff/partner-requests/{id}/done', { params: { path: { id } } }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: (r) => {
        toast.show(`${REQUEST_STATUS_TEXT[r.status] ?? r.status}. The resident was told where that applies.`);
        setDeclining(false);
        setCancelling(false);
        setFinishing(false);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/partners/requests" label="Partner requests" />} title="Request" />
        <ForbiddenState />
      </>
    );
  const r = request.data;
  const actions = r ? relayActions(r.status, r.consentWithdrawn) : null;
  return (
    <>
      <PageHeader
        back={<Back href="/partners/requests" label="Partner requests" />}
        title={r ? requestTitle(r) : 'Request'}
        description={r ? `${r.partner.nameEn} · ${r.partner.businessPhone}` : undefined}
        actions={
          actions ? (
            <>
              {actions.decline ? (
                <Button variant="danger" onClick={() => setDeclining(true)}>
                  Decline
                </Button>
              ) : null}
              {actions.cancel ? (
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  Cancel
                </Button>
              ) : null}
              {actions.propose ? <Button onClick={() => setAnswering('propose')}>Propose a time</Button> : null}
              {actions.done ? <Button onClick={() => setFinishing(true)}>Mark done</Button> : null}
              {actions.accept ? (
                <Button variant="primary" onClick={() => setAnswering('accept')}>
                  Accept
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={request}>
        {r ? (
          <div className="stack">
            {r.consentWithdrawn ? (
              <Alert tone="warn">The resident withdrew the category’s consent: nothing of them is shown and the request takes no answer.</Alert>
            ) : null}
            <Card>
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.closeReason ? ` · ${humanize(r.closeReason)}` : ''}
                </dd>
                <dt>Unit</dt>
                <dd className="t-mono">{r.unitCode ?? '—'}</dd>
                <dt>Resident</dt>
                <dd>{r.firstName ?? '—'}</dd>
                <dt>Asked for</dt>
                <dd>
                  {formatDateTime(r.askedStartsAt)} – {formatDateTime(r.askedEndsAt)}
                </dd>
                {r.proposedStartsAt ? (
                  <>
                    <dt>Proposed</dt>
                    <dd>
                      {formatDateTime(r.proposedStartsAt)} – {r.proposedEndsAt ? formatDateTime(r.proposedEndsAt) : ''}
                    </dd>
                  </>
                ) : null}
                {r.agreedStartsAt ? (
                  <>
                    <dt>Agreed</dt>
                    <dd>
                      {formatDateTime(r.agreedStartsAt)} – {r.agreedEndsAt ? formatDateTime(r.agreedEndsAt) : ''} · {r.staffCount} coming
                    </dd>
                  </>
                ) : null}
                <dt>Note</dt>
                <dd>{r.note ?? '—'}</dd>
                <dt>Gate pass</dt>
                <dd>{r.gatePass ? (r.pass ? `Code ${r.pass.code ?? '—'} · until ${formatDateTime(r.pass.validUntil)}` : 'On acceptance') : 'Not asked'}</dd>
              </dl>
            </Card>
            {r.items.length ? (
              <Card>
                <ul>
                  {r.items.map((i, n) => (
                    <li key={n}>
                      {i.quantity} × {i.nameEn} — {i.price} EGP ({PRICE_UNIT_TEXT[i.unit] ?? i.unit})
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            <ErrorAlert error={act.error} />
          </div>
        ) : null}
      </QueryState>
      {answering && r ? <AnswerDialog request={r} kind={answering} onClose={() => setAnswering(null)} /> : null}
      <ReasonCodeDialog
        open={declining}
        onClose={() => setDeclining(false)}
        title="Decline for the partner?"
        description="The resident is told the reason."
        codes={REASON_CODES.partnerRequestDecline}
        confirmLabel="Decline"
        danger
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={(reasonCode) => act.mutate({ action: 'decline', reasonCode })}
      />
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel for the partner?"
        description="The resident is told the reason; the gate pass stops working."
        codes={REASON_CODES.partnerRequestPartnerCancel}
        confirmLabel="Cancel the request"
        danger
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={(reasonCode) => act.mutate({ action: 'cancel', reasonCode })}
      />
      <ConfirmDialog
        open={finishing}
        onClose={() => setFinishing(false)}
        title="Mark it done for the partner?"
        description="The resident is told and may rate it."
        confirmLabel="Mark done"
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={() => act.mutate({ action: 'done' })}
      />
    </>
  );
}
