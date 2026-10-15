'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { getPaymentGateway, keys, type PaymentGateway } from '@/lib/queries';
import { PlatformStepUpDialog } from './platform-step-up-dialog';

type Mode = 'sandbox' | 'live';
const masked = (v: string | null | undefined) => (v ? `••••${v}` : '—');

function keyProblem(key: string, kind: 'sk' | 'pk', mode: Mode): string | undefined {
  const v = key.trim();
  if (!v) return undefined;
  if (!new RegExp(`^egy_${kind}_(test|live)_[A-Za-z0-9_-]{8,240}$`).test(v)) return `Starts with egy_${kind}_test_ or egy_${kind}_live_.`;
  return v.startsWith(`egy_${kind}_live_`) === (mode === 'live') ? undefined : mode === 'live' ? 'Live mode takes a live key.' : 'Sandbox takes a test key.';
}

function CredentialsDialog({ tenantId, current, onClose }: { tenantId: string; current: PaymentGateway; onClose: () => void }) {
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
        toast.show('Saved. Only the last four characters are ever shown.');
        onClose();
      },
    },
  );
  const id = (v: string) => /^[1-9]\d{0,9}$/.test(v.trim());
  const ready =
    secretKey.trim() !== '' &&
    publicKey.trim() !== '' &&
    !keyProblem(secretKey, 'sk', mode) &&
    !keyProblem(publicKey, 'pk', mode) &&
    /^[A-Za-z0-9_-]{16,256}$/.test(hmacSecret.trim()) &&
    id(card) &&
    (wallet.trim() === '' || id(wallet));
  return (
    <>
      <Dialog
        open={!confirming}
        onClose={onClose}
        title="The compound’s Paymob credentials"
        description="From the compound’s own Paymob account; all replaced together and stored sealed. The compound’s managers see who set them last."
        onSubmit={() => ready && setConfirming(true)}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!ready} loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Mode">
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="sandbox">Sandbox (test)</option>
                <option value="live">Live</option>
              </Select>
            )}
          </Field>
          <Field label="Secret key" error={fieldError(save.error, 'secretKey') ?? keyProblem(secretKey, 'sk', mode)}>
            {(p) => <Input {...p} type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />}
          </Field>
          <Field label="Public key" error={fieldError(save.error, 'publicKey') ?? keyProblem(publicKey, 'pk', mode)}>
            {(p) => <Input {...p} autoComplete="off" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} />}
          </Field>
          <Field label="HMAC secret" error={fieldError(save.error, 'hmacSecret')}>
            {(p) => <Input {...p} type="password" autoComplete="off" value={hmacSecret} onChange={(e) => setHmac(e.target.value)} />}
          </Field>
          <Field label="Card integration id" error={fieldError(save.error, 'cardIntegrationId')}>
            {(p) => <Input {...p} inputMode="numeric" value={card} onChange={(e) => setCard(e.target.value)} />}
          </Field>
          <Field label="Mobile wallet integration id" hint="Leave empty for card only." error={fieldError(save.error, 'walletIntegrationId')}>
            {(p) => <Input {...p} inputMode="numeric" value={wallet} onChange={(e) => setWallet(e.target.value)} />}
          </Field>
          <ErrorAlert error={save.error} />
        </div>
      </Dialog>
      {confirming ? (
        <PlatformStepUpDialog
          title="Confirm it is you"
          description="A compound’s payment credentials change only after a fresh code sent to your email."
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
  const toast = useToast();
  const gateway = useQuery({ queryKey: keys.paymentGateway(tenantId), queryFn: () => getPaymentGateway(tenantId) });
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState<boolean | null>(null);
  const toggle = useAction(
    (platformDisabled: boolean) =>
      unwrap(api.PATCH('/api/v1/platform/tenants/{id}/payment-gateway', { params: { path: { id: tenantId } }, body: { platformDisabled } })),
    {
      invalidate: [keys.paymentGateway(tenantId)],
      onDone: (g) => toast.show(g.platformDisabled ? 'Online payment is switched off for this compound.' : 'The compound’s managers decide again.'),
    },
  );
  const g = gateway.data;
  return (
    <Card flush>
      <CardHeader title="Online payments">
        {g ? (
          <span className="row" style={{ gap: 8 }}>
            <Button size="sm" onClick={() => setEditing(true)}>
              {g.configured ? 'Replace credentials' : 'Set credentials'}
            </Button>
            <Button size="sm" variant={g.platformDisabled ? 'primary' : 'danger'} onClick={() => setSwitching(!g.platformDisabled)}>
              {g.platformDisabled ? 'Allow again' : 'Switch off'}
            </Button>
          </span>
        ) : null}
      </CardHeader>
      <CardBody>
        <ErrorAlert error={toggle.error} />
        <QueryState query={gateway} rows={3}>
          {g ? (
            <dl className="dl">
              <dt>Residents can pay online</dt>
              <dd>{g.available ? <Badge tone="green">Yes</Badge> : <Badge tone="beige">No</Badge>}</dd>
              <dt>Managers’ switch</dt>
              <dd>{g.onlineEnabled ? 'On' : 'Off'}</dd>
              <dt>Platform</dt>
              <dd>{g.platformDisabled ? <Badge tone="error">Switched off</Badge> : 'Allowed'}</dd>
              <dt>Mode</dt>
              <dd>{g.mode === 'live' ? 'Live' : g.mode === 'sandbox' ? 'Sandbox (test)' : '—'}</dd>
              <dt>Secret key</dt>
              <dd className="t-mono">{masked(g.last4?.secretKey)}</dd>
              <dt>Public key</dt>
              <dd className="t-mono">{masked(g.last4?.publicKey)}</dd>
              <dt>HMAC secret</dt>
              <dd className="t-mono">{masked(g.last4?.hmacSecret)}</dd>
              <dt>Integrations</dt>
              <dd className="t-mono">
                card {masked(g.last4?.cardIntegrationId)} · wallet {masked(g.last4?.walletIntegrationId)}
              </dd>
              <dt>Last set</dt>
              <dd>{g.updatedAt ? `${formatDateTime(g.updatedAt)} · by ${g.updatedBy === 'platform' ? 'the platform' : 'a manager'}` : '—'}</dd>
            </dl>
          ) : null}
        </QueryState>
      </CardBody>
      {editing && g ? <CredentialsDialog tenantId={tenantId} current={g} onClose={() => setEditing(false)} /> : null}
      {switching !== null ? (
        <PlatformStepUpDialog
          title={switching ? 'Switch online payment off' : 'Let the managers decide again'}
          description="Confirm with a fresh code sent to your email. Payments already made still land."
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
