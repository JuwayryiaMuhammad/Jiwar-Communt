'use client';

import { ApiError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Checkbox, Dialog, Field, Input, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Erasure } from '@/lib/queries';
import ar from '@/messages/ar/shell-accounts';
import en from '@/messages/en/shell-accounts';
import { blockerText, fieldText } from './labels';

/**
 * Erasing an account, in the API's three steps (ADR 0023): read what goes
 * and what stays, check no law requires keeping it, then type the scope
 * phrase. It cannot be undone: the personal data is blanked for good and
 * only the audit trail's ids remain.
 */
export function EraseDialog({ erasure, name, onClose }: { erasure: Erasure; name: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        toast.show(t('erase.done', { name }));
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
      title={t('erase.title', { name, step: f.number(step) })}
      description={step === 1 ? t('erase.step1') : step === 2 ? t('erase.step2') : t('erase.step3')}
      onSubmit={() => {
        if (step === 1 && s) setStep(2);
        else if (step === 2 && checked && !held) setStep(3);
        else if (step === 3 && s && typed.trim() === s.scopePhrase) erase.mutate();
      }}
      footer={
        <>
          <Button onClick={step === 1 ? onClose : () => setStep((step - 1) as 1 | 2)}>{step === 1 ? c('cancel') : c('back')}</Button>
          {step === 1 ? (
            <Button type="submit" variant="primary" disabled={!s}>
              {t('erase.continue')}
            </Button>
          ) : step === 2 ? (
            <Button type="submit" variant="primary" disabled={!checked || held}>
              {t('erase.continue')}
            </Button>
          ) : (
            <Button type="submit" variant="danger" loading={erase.isPending} disabled={!s || typed.trim() !== s.scopePhrase}>
              {t('erase.confirm')}
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
                <strong>{t('erase.removed')}</strong>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  <li>{t('erase.personal', { fields: f.list(s.erased.personalFields.map((field) => fieldText(t, field))) })}</li>
                  <li>
                    {s.erased.sessions ? t('erase.signInSessions', { n: s.erased.sessions }) : t('erase.signIn')}
                  </li>
                  {s.erased.activeOccupancies ? <li>{t('erase.occupancies', { n: s.erased.activeOccupancies })}</li> : null}
                  {s.erased.activeMemberships ? <li>{t('erase.memberships', { n: s.erased.activeMemberships })}</li> : null}
                  {s.erased.workerEngagementsRequested ? <li>{t('erase.workers', { n: s.erased.workerEngagementsRequested })}</li> : null}
                  {s.erased.invitesAccepted ? <li>{t('erase.invites', { n: s.erased.invitesAccepted })}</li> : null}
                  {s.erased.pendingMessages ? <li>{t('erase.messages', { n: s.erased.pendingMessages })}</li> : null}
                </ul>
              </div>
              <div className="stack stack--sm">
                <strong>{t('erase.kept')}</strong>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  <li>{t('erase.audit', { n: s.kept.auditEntries })}</li>
                  <li>{t('erase.row')}</li>
                </ul>
              </div>
              <p className="t-secondary">
                {t('erase.asked', {
                  by: erasure.assisted ? 'management' : 'person',
                  when: f.dateTime(erasure.requestedAt),
                  ended: f.dateTime(erasure.effectiveAt),
                })}
              </p>
            </div>
          ) : null}
        </QueryState>
      ) : null}

      {step === 2 ? (
        <div className="stack">
          <p>{t('erase.legal')}</p>
          {can('accounts.legal_hold') ? (
            <QueryState query={holds} rows={1}>
              {held ? (
                <Alert tone="error">
                  {t('erase.heldReasons', { reasons: f.list((holds.data?.data ?? []).map((h) => label(h.reasonCode))) })}{' '}
                  <Link href={`/accounts/${erasure.accountId}`}>{t('erase.releaseLink')}</Link>
                </Alert>
              ) : (
                <Alert tone="info">
                  {t('erase.noHold')} <Link href={`/accounts/${erasure.accountId}`}>{t('erase.placeLink')}</Link>
                </Alert>
              )}
            </QueryState>
          ) : held ? (
            <Alert tone="error">{t('erase.held')}</Alert>
          ) : (
            <Alert tone="info">{t('erase.noHoldHere')}</Alert>
          )}
          <Checkbox label={t('erase.checked')} checked={checked} disabled={held} onChange={(e) => setChecked(e.target.checked)} />
        </div>
      ) : null}

      {step === 3 && s ? (
        <div className="form">
          <Alert tone="warn">{t('erase.warn', { name })}</Alert>
          <div className="stack stack--sm">
            <span className="t-secondary">{t('erase.phrase')}</span>
            <span className="code-box">{s.scopePhrase}</span>
          </div>
          <Field label={t('erase.type')} error={typed.trim() !== '' && typed.trim() !== s.scopePhrase ? t('erase.notSame') : undefined}>
            {(p) => <Input {...p} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Field>
          <ErrorAlert error={erase.error} />
          {Array.isArray(blockers) ? (
            <Alert tone="error">
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {(blockers as string[]).map((b) => (
                  <li key={b}>{blockerText(t, label, b)}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
