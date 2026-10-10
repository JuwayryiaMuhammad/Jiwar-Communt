'use client';

import { ApiError, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Button, Checkbox, Dialog, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Erasure } from '@/lib/queries';
import { BLOCKER_TEXT, fieldLabel } from './labels';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Erasing an account, in the API's three steps (ADR 0023): read what goes
 * and what stays, check no law requires keeping it, then type the scope
 * phrase. It cannot be undone: the personal data is blanked for good and
 * only the audit trail's ids remain.
 */
export function EraseDialog({ erasure, name, onClose }: { erasure: Erasure; name: string; onClose: () => void }) {
  const toast = useToast();
  const { can } = usePermissions();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');

  const scope = useQuery({
    // A key of its own: refreshing the queue after the erase must not ask for
    // the scope of a request that is no longer open.
    queryKey: ['erasure-scope', erasure.id],
    queryFn: () => unwrap(api.GET('/api/v1/erasures/{id}/scope', { params: { path: { id: erasure.id } } })),
    // Counted fresh each time: what hangs off the account may have changed.
    gcTime: 0,
  });
  const holds = useQuery({
    queryKey: keys.accountPart(erasure.accountId, 'legal-holds'),
    queryFn: () => fetchers.legalHolds(erasure.accountId),
    enabled: step === 2 && can('accounts.legal_hold'),
  });
  const erase = useAction(
    () => unwrap(api.POST('/api/v1/erasures/{id}/erase', { params: { path: { id: erasure.id } }, body: { typedScope: typed.trim() } })),
    {
      invalidate: [keys.erasures, keys.account(erasure.accountId), keys.accounts, keys.residents],
      onDone: () => {
        toast.show(`${name}'s account is erased.`);
        onClose();
      },
    },
  );

  const s = scope.data;
  const held = can('accounts.legal_hold') ? (holds.data?.data.length ?? 0) > 0 : erasure.onLegalHold;
  const blockers = erase.error instanceof ApiError && erase.error.code === 'DELETION_BLOCKED' ? erase.error.params.blockers : undefined;

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Erase ${name}'s account · step ${step} of 3`}
      description={
        step === 1
          ? 'What will be removed, and what is kept.'
          : step === 2
            ? 'Is there a legal obligation to keep this data?'
            : 'This cannot be undone.'
      }
      onSubmit={() => {
        if (step === 1 && s) setStep(2);
        else if (step === 2 && checked && !held) setStep(3);
        else if (step === 3 && s && typed.trim() === s.scopePhrase) erase.mutate();
      }}
      footer={
        <>
          <Button onClick={step === 1 ? onClose : () => setStep((step - 1) as 1 | 2)}>{step === 1 ? 'Cancel' : 'Back'}</Button>
          {step === 1 ? (
            <Button type="submit" variant="primary" disabled={!s}>
              Continue
            </Button>
          ) : step === 2 ? (
            <Button type="submit" variant="primary" disabled={!checked || held}>
              Continue
            </Button>
          ) : (
            <Button type="submit" variant="danger" loading={erase.isPending} disabled={!s || typed.trim() !== s.scopePhrase}>
              Erase for good
            </Button>
          )}
        </>
      }
    >
      {step === 1 ? (
        <QueryState query={scope} rows={4}>
          {s ? (
            <div className="stack">
              <div className="stack stack--sm">
                <strong>Removed for good</strong>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Personal data: {s.erased.personalFields.map(fieldLabel).join(', ').toLowerCase()}</li>
                  <li>
                    Sign-in: they can never sign in again
                    {s.erased.sessions ? `; ${count(s.erased.sessions, 'session', 'sessions')} ended now` : ''}
                  </li>
                  {s.erased.activeOccupancies ? <li>{count(s.erased.activeOccupancies, 'occupancy', 'occupancies')} of a unit ended</li> : null}
                  {s.erased.activeMemberships ? <li>{count(s.erased.activeMemberships, 'household membership', 'household memberships')} ended</li> : null}
                  {s.erased.workerEngagementsRequested ? (
                    <li>{count(s.erased.workerEngagementsRequested, 'domestic worker they registered', 'domestic workers they registered')} ended</li>
                  ) : null}
                  {s.erased.invitesAccepted ? <li>{count(s.erased.invitesAccepted, 'accepted invite', 'accepted invites')} unlinked</li> : null}
                  {s.erased.pendingMessages ? <li>{count(s.erased.pendingMessages, 'unsent email', 'unsent emails')} dropped</li> : null}
                </ul>
              </div>
              <div className="stack stack--sm">
                <strong>Kept</strong>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>
                    {count(s.kept.auditEntries, 'audit entry', 'audit entries')}: what was done and when, by id only, with no name or contact detail
                  </li>
                  <li>The account's row as an empty record, so tickets and entries it took part in still add up</li>
                </ul>
              </div>
              <p className="t-secondary">
                Asked {formatDateTime(erasure.requestedAt)}
                {erasure.assisted ? ' by management for the person' : ' by the person'}; cooling-off ended {formatDateTime(erasure.effectiveAt)}.
              </p>
            </div>
          ) : null}
        </QueryState>
      ) : null}

      {step === 2 ? (
        <div className="stack">
          <p>
            Data under a dispute, a regulator's request or a financial audit must be kept. If any applies, stop here and place a legal hold
            on the account instead.
          </p>
          {can('accounts.legal_hold') ? (
            <QueryState query={holds} rows={1}>
              {held ? (
                <Alert tone="error">
                  This account is on legal hold ({holds.data?.data.map((h) => humanize(h.reasonCode).toLowerCase()).join(', ')}). It cannot be
                  erased until the hold is released on <Link href={`/accounts/${erasure.accountId}`}>its account page</Link>.
                </Alert>
              ) : (
                <Alert tone="info">
                  No legal hold is recorded. To place one, open <Link href={`/accounts/${erasure.accountId}`}>the account page</Link>.
                </Alert>
              )}
            </QueryState>
          ) : held ? (
            <Alert tone="error">This account is on legal hold. It cannot be erased until the hold is released.</Alert>
          ) : (
            <Alert tone="info">No legal hold is recorded on this account.</Alert>
          )}
          <Checkbox
            label="I checked: nothing requires this data to be kept"
            checked={checked}
            disabled={held}
            onChange={(e) => setChecked(e.target.checked)}
          />
        </div>
      ) : null}

      {step === 3 && s ? (
        <div className="form">
          <Alert tone="warn">
            Erasing blanks {name}'s personal data for good. Nobody, including the platform, can bring it back.
          </Alert>
          <div className="stack stack--sm">
            <span className="t-secondary">The phrase for this account:</span>
            <span className="code-box">{s.scopePhrase}</span>
          </div>
          <Field label="Type the phrase to confirm" error={typed.trim() !== '' && typed.trim() !== s.scopePhrase ? 'Not the same yet.' : undefined}>
            {(p) => <Input {...p} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Field>
          <ErrorAlert error={erase.error} />
          {Array.isArray(blockers) ? (
            <Alert tone="error">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(blockers as string[]).map((b) => (
                  <li key={b}>{BLOCKER_TEXT[b] ?? humanize(b)}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
