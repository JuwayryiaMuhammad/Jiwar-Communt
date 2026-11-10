'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ALARMING, keyProblem, masked } from '@/components/finance/logic';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GatewayEvent, type GatewayView } from '@/lib/queries';
import ar from '@/messages/ar/fin-gateway';
import codesAr from '@/messages/ar/fin-codes';
import en from '@/messages/en/fin-gateway';
import codesEn from '@/messages/en/fin-codes';

type Mode = 'sandbox' | 'live';
interface Credentials {
  mode: Mode;
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  cardIntegrationId: number;
  walletIntegrationId: number | null;
}

const OUTCOMES = [
  'applied',
  'duplicate',
  'failed_attempt',
  'not_final',
  'verification_pending',
  'contradicted',
  'order_mismatch',
  'amount_mismatch',
  'unknown_reference',
] as const satisfies readonly GatewayEvent['outcome'][];

/** The credentials form; Save asks for a step-up code, then sends them all. */
function CredentialsDialog({ current, onClose }: { current: GatewayView; onClose: () => void }) {
  const t = useT(en, ar);
  const k = useT(codesEn, codesAr);
  const c = useCommonT();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(current.mode ?? 'sandbox');
  const [secretKey, setSecretKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [hmacSecret, setHmac] = useState('');
  const [card, setCard] = useState('');
  const [wallet, setWallet] = useState('');
  const [confirming, setConfirming] = useState(false);
  const save = useAction(
    (body: Credentials) => unwrap(api.PUT('/api/v1/staff/finance/gateway', { body })),
    {
      invalidate: [keys.financeGateway],
      onDone: () => {
        toast.show(t('saved'));
        onClose();
      },
    },
  );
  const id = (v: string) => /^[1-9]\d{0,9}$/.test(v.trim());
  const ready =
    !keyProblem(k, secretKey, 'sk', mode) &&
    !keyProblem(k, publicKey, 'pk', mode) &&
    secretKey.trim() !== '' &&
    publicKey.trim() !== '' &&
    /^[A-Za-z0-9_-]{16,256}$/.test(hmacSecret.trim()) &&
    id(card) &&
    (wallet.trim() === '' || id(wallet));
  const body = (): Credentials => ({
    mode,
    secretKey: secretKey.trim(),
    publicKey: publicKey.trim(),
    hmacSecret: hmacSecret.trim(),
    cardIntegrationId: Number(card),
    walletIntegrationId: wallet.trim() ? Number(wallet) : null,
  });

  return (
    <>
      <Dialog
        open={!confirming}
        onClose={onClose}
        title={t('credentialsTitle')}
        description={t('credentialsDescription')}
        onSubmit={() => ready && setConfirming(true)}
        footer={
          <>
            <Button onClick={onClose}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={save.isPending}>
              {c('save')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('mode')} hint={t('modeHint')}>
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="sandbox">{t('mode.sandbox')}</option>
                <option value="live">{t('mode.live')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('secretKey')} error={fieldError(save.error, 'secretKey') ?? keyProblem(k, secretKey, 'sk', mode)}>
            {(p) => <Input {...p} type="password" autoComplete="off" className="ltr" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />}
          </Field>
          <Field label={t('publicKey')} error={fieldError(save.error, 'publicKey') ?? keyProblem(k, publicKey, 'pk', mode)}>
            {(p) => <Input {...p} autoComplete="off" className="ltr" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />}
          </Field>
          <Field label={t('hmacSecret')} error={fieldError(save.error, 'hmacSecret')}>
            {(p) => <Input {...p} type="password" autoComplete="off" className="ltr" value={hmacSecret} onChange={(e) => setHmac(e.target.value)} />}
          </Field>
          <Field label={t('cardId')} error={fieldError(save.error, 'cardIntegrationId')}>
            {(p) => <Input {...p} inputMode="numeric" className="ltr" value={card} onChange={(e) => setCard(e.target.value)} />}
          </Field>
          <Field label={t('walletId')} hint={t('walletHint')} error={fieldError(save.error, 'walletIntegrationId')}>
            {(p) => <Input {...p} inputMode="numeric" className="ltr" value={wallet} onChange={(e) => setWallet(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </Dialog>
      {confirming ? (
        <StepUpDialog
          title={t('confirmTitle')}
          description={t('confirmDescription')}
          onClose={() => setConfirming(false)}
          onVerified={() => {
            setConfirming(false);
            save.mutate(body());
          }}
        />
      ) : null}
    </>
  );
}

function Events() {
  const t = useT(en, ar);
  const k = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const [view, setView] = useState<'alerts' | 'all'>('alerts');
  const [outcome, setOutcome] = useState<GatewayEvent['outcome'] | ''>('');
  const list = useCursorList(keys.gatewayEvents(outcome), (cursor) => fetchers.gatewayEvents(outcome, cursor));
  const rows = (list.rows ?? []).filter((e) => view === 'all' || outcome !== '' || ALARMING.has(e.outcome));
  return (
    <Card flush>
      <CardHeader
        title={t('callbacksTitle')}
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Segmented<'alerts' | 'all'>
              label={t('shown')}
              value={view}
              onChange={setView}
              options={[
                { value: 'alerts', label: t('view.alerts') },
                { value: 'all', label: c('all') },
              ]}
            />
            <Select aria-label={t('outcome')} value={outcome} onChange={(e) => setOutcome(e.target.value as GatewayEvent['outcome'] | '')}>
              <option value="">{t('anyOutcome')}</option>
              {OUTCOMES.map((v) => (
                <option key={v} value={v}>
                  {k(`outcome.${v}`)}
                </option>
              ))}
            </Select>
          </span>
        }
      />
      <QueryState query={list}>
        <DataTable<GatewayEvent>
          rows={rows}
          rowKey={(e) => e.id}
          empty={t('nothing')}
          columns={[
            { key: 'when', header: t('col.received'), cell: (e) => f.dateTime(e.createdAt) },
            {
              key: 'outcome',
              header: t('outcome'),
              cell: (e) => (
                <Badge tone={ALARMING.has(e.outcome) ? 'error' : e.outcome === 'applied' ? 'green' : 'beige'}>{k(`outcome.${e.outcome}`)}</Badge>
              ),
            },
            { key: 'amount', header: c('amount'), cell: (e) => f.money(e.amount) },
            { key: 'txn', header: t('col.transaction'), cell: (e) => <span className="t-mono ltr">{e.gatewayTransactionId}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

/**
 * The compound's online payment account (ADR 0046), for its manager:
 * the Paymob credentials (shown by their last four characters), the switch
 * that lets residents pay online, and Paymob's callbacks. Every change asks
 * for a fresh code first.
 */
export default function GatewayPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.gateway');
  const gateway = useQuery({ queryKey: keys.financeGateway, queryFn: fetchers.financeGateway, enabled: allowed });
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState<boolean | null>(null);
  const toggle = useAction(
    (onlineEnabled: boolean) => unwrap(api.PATCH('/api/v1/staff/finance/gateway', { body: { onlineEnabled } })),
    { invalidate: [keys.financeGateway], onDone: (g) => toast.show(g.onlineEnabled ? t('onToast') : t('offToast')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const g = gateway.data;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          g ? (
            <>
              <Button onClick={() => setEditing(true)}>{g.configured ? t('replaceCredentials') : t('setCredentials')}</Button>
              <Button variant={g.onlineEnabled ? 'danger' : 'primary'} disabled={!g.configured && !g.onlineEnabled} onClick={() => setSwitching(!g.onlineEnabled)}>
                {g.onlineEnabled ? t('turnOff') : t('turnOn')}
              </Button>
            </>
          ) : undefined
        }
      />
      <ErrorAlert error={toggle.error} />
      <QueryState query={gateway}>
        {g ? (
          <div className="stack">
            <Card>
              <CardBody>
                <dl className="dl">
                  <dt>{t('canPay')}</dt>
                  <dd>{g.available ? <Badge tone="green">{c('yes')}</Badge> : <Badge tone="beige">{c('no')}</Badge>}</dd>
                  <dt>{t('switchedOn')}</dt>
                  <dd>{g.onlineEnabled ? c('yes') : c('no')}</dd>
                  {g.platformDisabled ? (
                    <>
                      <dt>{t('platform')}</dt>
                      <dd>
                        <Badge tone="error">{t('platformOff')}</Badge>
                      </dd>
                    </>
                  ) : null}
                  <dt>{t('mode')}</dt>
                  <dd>{g.mode === 'live' ? t('mode.live') : g.mode === 'sandbox' ? t('mode.sandbox') : '—'}</dd>
                  <dt>{t('secretKey')}</dt>
                  <dd className="t-mono ltr">{masked(g.last4?.secretKey)}</dd>
                  <dt>{t('publicKey')}</dt>
                  <dd className="t-mono ltr">{masked(g.last4?.publicKey)}</dd>
                  <dt>{t('hmacSecret')}</dt>
                  <dd className="t-mono ltr">{masked(g.last4?.hmacSecret)}</dd>
                  <dt>{t('cardIntegration')}</dt>
                  <dd className="t-mono ltr">{masked(g.last4?.cardIntegrationId)}</dd>
                  <dt>{t('walletIntegration')}</dt>
                  <dd className="t-mono ltr">{masked(g.last4?.walletIntegrationId)}</dd>
                  <dt>{t('lastSet')}</dt>
                  <dd>
                    {g.updatedAt
                      ? t('lastSetBy', { when: f.dateTime(g.updatedAt), by: g.updatedBy === 'platform' ? t('by.platform') : t('by.manager') })
                      : '—'}
                  </dd>
                </dl>
              </CardBody>
            </Card>
            {g.configured ? <Events /> : null}
          </div>
        ) : null}
      </QueryState>
      {editing && g ? <CredentialsDialog current={g} onClose={() => setEditing(false)} /> : null}
      {switching !== null ? (
        <StepUpDialog
          title={switching ? t('stepOn') : t('stepOff')}
          description={t('stepDescription')}
          onClose={() => setSwitching(null)}
          onVerified={() => {
            toggle.mutate(switching);
            setSwitching(null);
          }}
        />
      ) : null}
    </>
  );
}
