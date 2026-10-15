'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { ALARMING, keyProblem, masked, OUTCOME_TEXT } from '@/components/finance/logic';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GatewayEvent, type GatewayView } from '@/lib/queries';

type Mode = 'sandbox' | 'live';
interface Credentials {
  mode: Mode;
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  cardIntegrationId: number;
  walletIntegrationId: number | null;
}

/** The credentials form; Save asks for a step-up code, then sends them all. */
function CredentialsDialog({ current, onClose }: { current: GatewayView; onClose: () => void }) {
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
        toast.show('Saved. Only the last four characters are ever shown.');
        onClose();
      },
    },
  );
  const id = (v: string) => /^[1-9]\d{0,9}$/.test(v.trim());
  const ready =
    !keyProblem(secretKey, 'sk', mode) &&
    !keyProblem(publicKey, 'pk', mode) &&
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
        title="Paymob credentials"
        description="From the compound’s own Paymob account. All of them are replaced together and stored sealed; nobody can read them back, here or anywhere."
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
          <Field label="Mode" hint="Sandbox takes test keys; live takes live keys.">
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
        <StepUpDialog
          title="Confirm it is you"
          description="Payment credentials change only after a fresh code sent to your email."
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
  const [view, setView] = useState<'alerts' | 'all'>('alerts');
  const [outcome, setOutcome] = useState<GatewayEvent['outcome'] | ''>('');
  const list = useCursorList(keys.gatewayEvents(outcome), (c) => fetchers.gatewayEvents(outcome, c));
  const rows = (list.rows ?? []).filter((e) => view === 'all' || outcome !== '' || ALARMING.has(e.outcome));
  return (
    <Card flush>
      <CardHeader
        title="Paymob’s callbacks"
        actions={
          <span className="row" style={{ gap: 8 }}>
            <Segmented<'alerts' | 'all'>
              label="Shown"
              value={view}
              onChange={setView}
              options={[
                { value: 'alerts', label: 'To look at' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as GatewayEvent['outcome'] | '')}>
              <option value="">Any outcome</option>
              {Object.entries(OUTCOME_TEXT).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
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
          empty="Nothing to look at"
          columns={[
            { key: 'when', header: 'Received', cell: (e) => formatDateTime(e.createdAt) },
            {
              key: 'outcome',
              header: 'Outcome',
              cell: (e) => <Badge tone={ALARMING.has(e.outcome) ? 'error' : e.outcome === 'applied' ? 'green' : 'beige'}>{OUTCOME_TEXT[e.outcome] ?? e.outcome}</Badge>,
            },
            { key: 'amount', header: 'Amount', cell: (e) => egp(e.amount) },
            { key: 'txn', header: 'Paymob transaction', cell: (e) => <span className="t-mono">{e.gatewayTransactionId}</span> },
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
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('finance.gateway');
  const gateway = useQuery({ queryKey: keys.financeGateway, queryFn: fetchers.financeGateway, enabled: allowed });
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState<boolean | null>(null);
  const toggle = useAction(
    (onlineEnabled: boolean) => unwrap(api.PATCH('/api/v1/staff/finance/gateway', { body: { onlineEnabled } })),
    { invalidate: [keys.financeGateway], onDone: (g) => toast.show(g.onlineEnabled ? 'Online payment is on.' : 'Online payment is off.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Online payments" />
        <ForbiddenState />
      </>
    );
  const g = gateway.data;
  return (
    <>
      <PageHeader
        title="Online payments"
        description="Residents pay their invoices by card or mobile wallet on Paymob’s own page, into the compound’s own Paymob account. A payment counts only once Paymob confirms it to the server."
        actions={
          g ? (
            <>
              <Button onClick={() => setEditing(true)}>{g.configured ? 'Replace credentials' : 'Set credentials'}</Button>
              <Button variant={g.onlineEnabled ? 'danger' : 'primary'} disabled={!g.configured && !g.onlineEnabled} onClick={() => setSwitching(!g.onlineEnabled)}>
                {g.onlineEnabled ? 'Turn off' : 'Turn on'}
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
                  <dt>Residents can pay online</dt>
                  <dd>{g.available ? <Badge tone="green">Yes</Badge> : <Badge tone="beige">No</Badge>}</dd>
                  <dt>Switched on</dt>
                  <dd>{g.onlineEnabled ? 'Yes' : 'No'}</dd>
                  {g.platformDisabled ? (
                    <>
                      <dt>Platform</dt>
                      <dd>
                        <Badge tone="error">Switched off by the platform</Badge>
                      </dd>
                    </>
                  ) : null}
                  <dt>Mode</dt>
                  <dd>{g.mode === 'live' ? 'Live' : g.mode === 'sandbox' ? 'Sandbox (test)' : '—'}</dd>
                  <dt>Secret key</dt>
                  <dd className="t-mono">{masked(g.last4?.secretKey)}</dd>
                  <dt>Public key</dt>
                  <dd className="t-mono">{masked(g.last4?.publicKey)}</dd>
                  <dt>HMAC secret</dt>
                  <dd className="t-mono">{masked(g.last4?.hmacSecret)}</dd>
                  <dt>Card integration</dt>
                  <dd className="t-mono">{masked(g.last4?.cardIntegrationId)}</dd>
                  <dt>Wallet integration</dt>
                  <dd className="t-mono">{masked(g.last4?.walletIntegrationId)}</dd>
                  <dt>Last set</dt>
                  <dd>{g.updatedAt ? `${formatDateTime(g.updatedAt)} · by ${g.updatedBy === 'platform' ? 'the platform' : 'a manager'}` : '—'}</dd>
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
          title={switching ? 'Turn online payment on' : 'Turn online payment off'}
          description="This changes how residents pay. Confirm with a fresh code sent to your email."
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
