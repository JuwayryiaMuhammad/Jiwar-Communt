'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/facilities/bits';
import { fromLocalInput } from '@/components/facilities/logic';
import { localName } from '@/components/management-requests/logic';
import { relayActions, requestTitle, word } from '@/components/partners/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PartnerRequest } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-requests';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-requests';

type Answer = { kind: 'accept'; staffCount: number } | { kind: 'propose'; startsAt: string; endsAt: string; staffCount: number };

function AnswerDialog({ request, kind, onClose }: { request: PartnerRequest; kind: Answer['kind']; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(kind === 'accept' ? t('accept.done') : t('propose.done'));
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
      title={kind === 'accept' ? t('accept.title') : t('propose.title')}
      description={
        kind === 'accept'
          ? t('accept.description')
          : t('propose.description')
      }
      onSubmit={() => ready && send.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={send.isPending} disabled={!ready}>
            {kind === 'accept' ? t('accept') : t('propose.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        {kind === 'propose' ? (
          <>
            <Field label={c('from')} error={fieldError(send.error, 'windowStartsAt')}>
              {(p) => <Input {...p} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
            </Field>
            <Field label={c('to')} error={fieldError(send.error, 'windowEndsAt')}>
              {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Field label={t('staffCount')} hint={t('staffCountHint')} error={fieldError(send.error, 'staffCount')}>
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
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(t('answered', { status: word(codes, 'status', r.status) }));
        setDeclining(false);
        setCancelling(false);
        setFinishing(false);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={<Back href="/partners/requests" label={t('title')} />} title={t('request')} />
        <ForbiddenState />
      </>
    );
  const r = request.data;
  const actions = r ? relayActions(r.status, r.consentWithdrawn) : null;
  return (
    <>
      <PageHeader
        back={<Back href="/partners/requests" label={t('title')} />}
        title={r ? requestTitle(codes, r, locale) : t('request')}
        description={r ? <>{localName(locale, r.partner)} · <span className="ltr">{r.partner.businessPhone}</span></> : undefined}
        actions={
          actions ? (
            <>
              {actions.decline ? (
                <Button variant="danger" onClick={() => setDeclining(true)}>
                  {t('decline')}
                </Button>
              ) : null}
              {actions.cancel ? (
                <Button variant="danger" onClick={() => setCancelling(true)}>
                  {t('cancel')}
                </Button>
              ) : null}
              {actions.propose ? <Button onClick={() => setAnswering('propose')}>{t('propose')}</Button> : null}
              {actions.done ? <Button onClick={() => setFinishing(true)}>{t('markDone')}</Button> : null}
              {actions.accept ? (
                <Button variant="primary" onClick={() => setAnswering('accept')}>
                  {t('accept')}
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
              <Alert tone="warn">{t('withdrawn')}</Alert>
            ) : null}
            <Card>
              <dl className="dl">
                <dt>{c('status')}</dt>
                <dd>
                  <StatusBadge status={r.status} />
                  {r.closeReason ? ` · ${label(r.closeReason)}` : ''}
                </dd>
                <dt>{c('unit')}</dt>
                <dd className="t-mono ltr">{r.unitCode ?? '—'}</dd>
                <dt>{c('resident')}</dt>
                <dd>{r.firstName ?? '—'}</dd>
                <dt>{t('askedFor')}</dt>
                <dd>
                  {f.dateTime(r.askedStartsAt)} – {f.dateTime(r.askedEndsAt)}
                </dd>
                {r.proposedStartsAt ? (
                  <>
                    <dt>{t('proposed')}</dt>
                    <dd>
                      {f.dateTime(r.proposedStartsAt)} – {r.proposedEndsAt ? f.dateTime(r.proposedEndsAt) : ''}
                    </dd>
                  </>
                ) : null}
                {r.agreedStartsAt ? (
                  <>
                    <dt>{t('agreed')}</dt>
                    <dd>
                      {f.dateTime(r.agreedStartsAt)} – {r.agreedEndsAt ? f.dateTime(r.agreedEndsAt) : ''} · {t('coming', { count: f.number(r.staffCount) })}
                    </dd>
                  </>
                ) : null}
                <dt>{c('note')}</dt>
                <dd>{r.note ?? '—'}</dd>
                <dt>{t('gatePass')}</dt>
                <dd>
                  {r.gatePass
                    ? r.pass
                      ? t('gatePass.code', { code: r.pass.code ?? '—', date: f.dateTime(r.pass.validUntil) })
                      : t('gatePass.onAcceptance')
                    : t('gatePass.notAsked')}
                </dd>
              </dl>
            </Card>
            {r.items.length ? (
              <Card>
                <ul>
                  {r.items.map((i, n) => (
                    <li key={n}>
                      {f.number(i.quantity)} × {localName(locale, i)} — {f.money(i.price)} ({word(codes, 'unit', i.unit)})
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
        title={t('declineDialog.title')}
        description={t('declineDialog.description')}
        codes={REASON_CODES.partnerRequestDecline}
        confirmLabel={t('decline')}
        danger
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={(reasonCode) => act.mutate({ action: 'decline', reasonCode })}
      />
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('cancelDialog.title')}
        description={t('cancelDialog.description')}
        codes={REASON_CODES.partnerRequestPartnerCancel}
        confirmLabel={t('cancelDialog.confirm')}
        danger
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={(reasonCode) => act.mutate({ action: 'cancel', reasonCode })}
      />
      <ConfirmDialog
        open={finishing}
        onClose={() => setFinishing(false)}
        title={t('doneDialog.title')}
        description={t('doneDialog.description')}
        confirmLabel={t('markDone')}
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={() => act.mutate({ action: 'done' })}
      />
    </>
  );
}
