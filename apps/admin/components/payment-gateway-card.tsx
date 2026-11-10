'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT, type Translate } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { getPaymentGateway, keys, type PaymentGateway } from '@/lib/queries';
import ar from '@/messages/ar/payments';
import en from '@/messages/en/payments';
import { PlatformStepUpDialog } from './platform-step-up-dialog';

type Mode = 'sandbox' | 'live';
const MODES = ['sandbox', 'live'] as const;
const masked = (v: string | null | undefined) => (v ? `••••${v}` : '—');

function keyProblem(t: Translate<typeof en>, key: string, kind: 'sk' | 'pk', mode: Mode): string | undefined {
  const v = key.trim();
  if (!v) return undefined;
  if (!new RegExp(`^egy_${kind}_(test|live)_[A-Za-z0-9_-]{8,240}$`).test(v)) {
    return t('key.prefix', { test: `egy_${kind}_test_`, live: `egy_${kind}_live_` });
  }
  return v.startsWith(`egy_${kind}_live_`) === (mode === 'live') ? undefined : mode === 'live' ? t('key.live') : t('key.test');
}

function CredentialsDialog({ tenantId, current, onClose }: { tenantId: string; current: PaymentGateway; onClose: () => void }) {
  const t = useT(en, ar);
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
    () =>
      unwrap(
        api.PUT('/api/v1/platform/tenants/{id}/payment-gateway', {
          params: { path: { id: tenantId } },
          body: {
            mode,
            secretKey: secretKey.trim(),
            publicKey: publicKey.trim(),
            hmacSecret: hmacSecret.trim(),
            cardIntegrationId: Number(card),
            walletIntegrationId: wallet.trim() ? Number(wallet) : null,
          },
        }),
      ),
    {
      invalidate: [keys.paymentGateway(tenantId)],
      onDone: () => {
        toast.show(t('creds.saved'));
        onClose();
      },
    },
  );
  const id = (v: string) => /^[1-9]\d{0,9}$/.test(v.trim());
  const ready =
    secretKey.trim() !== '' &&
    publicKey.trim() !== '' &&
    !keyProblem(t, secretKey, 'sk', mode) &&
    !keyProblem(t, publicKey, 'pk', mode) &&
    /^[A-Za-z0-9_-]{16,256}$/.test(hmacSecret.trim()) &&
    id(card) &&
    (wallet.trim() === '' || id(wallet));
  return (
    <>
      <Dialog
        open={!confirming}
        onClose={onClose}
        title={t('creds.title')}
        description={t('creds.description')}
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
          <Field label={t('mode')}>
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`mode.${m}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('secretKey')} error={fieldError(save.error, 'secretKey') ?? keyProblem(t, secretKey, 'sk', mode)}>
            {(p) => <Input {...p} type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />}
          </Field>
          <Field label={t('publicKey')} error={fieldError(save.error, 'publicKey') ?? keyProblem(t, publicKey, 'pk', mode)}>
            {(p) => <Input {...p} autoComplete="off" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />}
          </Field>
          <Field label={t('hmacSecret')} error={fieldError(save.error, 'hmacSecret')}>
            {(p) => <Input {...p} type="password" autoComplete="off" value={hmacSecret} onChange={(e) => setHmac(e.target.value)} />}
          </Field>
          <Field label={t('creds.card')} error={fieldError(save.error, 'cardIntegrationId')}>
            {(p) => <Input {...p} inputMode="numeric" value={card} onChange={(e) => setCard(e.target.value)} />}
          </Field>
          <Field label={t('creds.wallet')} hint={t('creds.walletHint')} error={fieldError(save.error, 'walletIntegrationId')}>
            {(p) => <Input {...p} inputMode="numeric" value={wallet} onChange={(e) => setWallet(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </Dialog>
      {confirming ? (
        <PlatformStepUpDialog
          title={t('creds.confirmTitle')}
          description={t('creds.confirmDescription')}
          onClose={() => setConfirming(false)}
          onVerified={() => {
            setConfirming(false);
            save.mutate(undefined);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * A compound's online payment account (ADR 0046), from the platform: the
 * credentials by their last four characters, set here or by the compound's
 * managers, and the platform's own switch, which turns online payment off
 * whatever the managers say. Changes ask for a platform step-up.
 */
export function PaymentGatewayCard({ tenantId }: { tenantId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const gateway = useQuery({ queryKey: keys.paymentGateway(tenantId), queryFn: () => getPaymentGateway(tenantId) });
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState<boolean | null>(null);
  const toggle = useAction(
    (platformDisabled: boolean) =>
      unwrap(api.PATCH('/api/v1/platform/tenants/{id}/payment-gateway', { params: { path: { id: tenantId } }, body: { platformDisabled } })),
    {
      invalidate: [keys.paymentGateway(tenantId)],
      onDone: (g) => toast.show(g.platformDisabled ? t('card.switchedOffToast') : t('card.allowedToast')),
    },
  );
  const g = gateway.data;
  return (
    <Card flush>
      <CardHeader title={t('card.title')}>
        {g ? (
          <span className="row" style={{ gap: 8 }}>
            <Button size="sm" onClick={() => setEditing(true)}>
              {g.configured ? t('card.replace') : t('card.set')}
            </Button>
            <Button size="sm" variant={g.platformDisabled ? 'primary' : 'danger'} onClick={() => setSwitching(!g.platformDisabled)}>
              {g.platformDisabled ? t('card.allow') : t('card.switchOff')}
            </Button>
          </span>
        ) : null}
      </CardHeader>
      <CardBody>
        <ErrorAlert error={toggle.error} />
        <QueryState query={gateway} rows={3}>
          {g ? (
            <dl className="dl">
              <dt>{t('card.available')}</dt>
              <dd>{g.available ? <Badge tone="green">{c('yes')}</Badge> : <Badge tone="beige">{c('no')}</Badge>}</dd>
              <dt>{t('card.managersSwitch')}</dt>
              <dd>{g.onlineEnabled ? t('card.on') : t('card.off')}</dd>
              <dt>{t('card.platform')}</dt>
              <dd>{g.platformDisabled ? <Badge tone="error">{t('card.switchedOff')}</Badge> : t('card.allowed')}</dd>
              <dt>{t('mode')}</dt>
              <dd>{g.mode ? t(`mode.${g.mode}`) : '—'}</dd>
              <dt>{t('secretKey')}</dt>
              <dd className="t-mono">
                <bdi>{masked(g.last4?.secretKey)}</bdi>
              </dd>
              <dt>{t('publicKey')}</dt>
              <dd className="t-mono">
                <bdi>{masked(g.last4?.publicKey)}</bdi>
              </dd>
              <dt>{t('hmacSecret')}</dt>
              <dd className="t-mono">
                <bdi>{masked(g.last4?.hmacSecret)}</bdi>
              </dd>
              <dt>{t('card.integrations')}</dt>
              <dd className="t-mono">
                {t('card.integrationsValue', {
                  card: masked(g.last4?.cardIntegrationId),
                  wallet: masked(g.last4?.walletIntegrationId),
                })}
              </dd>
              <dt>{t('card.lastSet')}</dt>
              <dd>
                {g.updatedAt
                  ? t('card.lastSetValue', { when: fmt.dateTime(g.updatedAt), who: g.updatedBy === 'platform' ? 'platform' : 'manager' })
                  : '—'}
              </dd>
            </dl>
          ) : null}
        </QueryState>
      </CardBody>
      {editing && g ? <CredentialsDialog tenantId={tenantId} current={g} onClose={() => setEditing(false)} /> : null}
      {switching !== null ? (
        <PlatformStepUpDialog
          title={switching ? t('switch.offTitle') : t('switch.onTitle')}
          description={t('switch.description')}
          onClose={() => setSwitching(null)}
          onVerified={() => {
            toggle.mutate(switching);
            setSwitching(null);
          }}
        />
      ) : null}
    </Card>
  );
}
