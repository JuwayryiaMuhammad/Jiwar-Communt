'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Compensation } from '@/lib/queries';
import ar from '@/messages/ar/experience-cases';
import en from '@/messages/en/experience-cases';
import { CompensationDecision } from '@/components/experience/compensation-decision';

const KINDS = ['credit', 'apology', 'redo', 'priority'] as const;

/**
 * One case (ADR 0082): its unit, owner and due time, the signals that joined
 * it, its compensations (proposed here, decided by the manager) and its
 * close, once, with an outcome. The rule recommended for what failed is
 * shown when the compound has one.
 */
export default function ExperienceCasePage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const w = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const kindOf = (k: string) => (k === 'recovery' ? t('kind.recovery') : k === 'follow_up' ? t('kind.follow_up') : label(k));
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const toast = useToast();
  const one = useQuery({ queryKey: keys.experienceCase(id), queryFn: () => fetchers.experienceCase(id), enabled: allowed });
  const rules = useQuery({ queryKey: keys.compensationRules, queryFn: fetchers.compensationRules, enabled: allowed });
  const [closing, setClosing] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [owner, setOwner] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('apology');
  const [failureCode, setFailureCode] = useState<string>('maintenance_delay');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const refresh = { invalidate: [keys.experienceAll] };
  const assign = useAction(
    () => unwrap(api.POST('/api/v1/staff/experience/cases/{id}/assign', { params: { path: { id } }, body: { ownerId: owner } })),
    { ...refresh, onDone: () => toast.show(t('ownerNamed')) },
  );
  const close = useAction(
    (outcome: string) => unwrap(api.POST('/api/v1/staff/experience/cases/{id}/close', { params: { path: { id } }, body: { outcome } })),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('closed'));
        setClosing(false);
      },
    },
  );
  const propose = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/experience/cases/{id}/compensations', {
          params: { path: { id } },
          body: { kind, failureCode, ...(kind === 'credit' ? { amount } : {}), ...(note.trim() ? { note } : {}) },
        }),
      ),
    {
      ...refresh,
      onDone: () => {
        toast.show(t('propose.done'));
        setProposing(false);
        setNote('');
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('caseTitle')} />
        <ForbiddenState />
      </>
    );
  const c = one.data;
  const recommended = rules.data?.data.find((r) => r.failureCode === (c?.failureCode ?? failureCode));
  return (
    <QueryState query={one}>
      {c ? (
        <>
          <PageHeader
            title={`${c.number} · ${c.unitCode ?? t('unitFallback')}`}
            description={t(c.origin === 'signal' ? 'caseSummary.signal' : 'caseSummary.staff', {
              kind: kindOf(c.kind),
              when: c.dueAt ? t('dueAt', { date: f.dateTime(c.dueAt) }) : label(c.outcome ?? c.status),
            })}
            actions={
              c.status === 'open' ? (
                <span className="row" style={{ gap: 6 }}>
                  <Button onClick={() => setProposing(true)}>{t('propose')}</Button>
                  <Button variant="primary" onClick={() => setClosing(true)}>
                    {t('close')}
                  </Button>
                </span>
              ) : null
            }
          />
          <Card>
            <div className="stack" style={{ padding: 12 }}>
              <span>
                <Badge>{label(c.status)}</Badge> {c.failureCode ? t('failedLine', { what: label(c.failureCode) }) : null}
              </span>
              {c.note ? <p>{c.note}</p> : null}
              {c.status === 'open' ? (
                <div className="form__row">
                  <Field label={t('owner')} hint={t('ownerHint')}>
                    {(p) => <Input {...p} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={c.ownerId ?? ''} />}
                  </Field>
                  <Button loading={assign.isPending} disabled={!owner} onClick={() => assign.mutate()}>
                    {t('nameOwner')}
                  </Button>
                </div>
              ) : null}
              <ErrorAlert error={assign.error} />
            </div>
          </Card>
          <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
            {t('compensationsTitle')}
          </h2>
          <Card flush>
            <DataTable<Compensation>
              rows={c.compensations ?? []}
              rowKey={(x) => x.id}
              empty={t('noneProposed')}
              columns={[
                { key: 'at', header: t('proposed'), width: 170, cell: (x) => f.dateTime(x.proposedAt) },
                { key: 'kind', header: w('kind'), cell: (x) => `${label(x.kind)}${x.amount ? ` · ${f.money(x.amount)}` : ''}` },
                { key: 'failure', header: t('whatFailed'), cell: (x) => label(x.failureCode) },
                { key: 'status', header: w('status'), cell: (x) => <Badge>{label(x.rejectReason ?? x.status)}</Badge> },
                { key: 'decide', header: '', cell: (x) => (can('experience.compensate') ? <CompensationDecision compensation={x} unitId={c.unitId} /> : null) },
              ]}
            />
          </Card>
          <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
            {t('signals')}
          </h2>
          <Card flush>
            <DataTable
              rows={c.signals ?? []}
              rowKey={(s) => s.id}
              empty={t('openedByHand')}
              columns={[
                { key: 'at', header: t('detected'), width: 170, cell: (s) => f.dateTime(s.detectedAt) },
                { key: 'rule', header: t('rule'), cell: (s) => label(s.code) },
                { key: 'count', header: t('events'), cell: (s) => t('eventsIn', { count: f.number(s.count), days: s.windowDays }) },
              ]}
            />
          </Card>
          <ReasonCodeDialog
            open={closing}
            onClose={() => setClosing(false)}
            title={t('closeTitle', { number: c.number })}
            description={t('closeDescription')}
            codes={REASON_CODES.experienceCaseOutcome}
            confirmLabel={t('closeConfirm')}
            pending={close.isPending}
            error={<ErrorAlert error={close.error} />}
            onConfirm={(code) => close.mutate(code)}
          />
          <Dialog
            open={proposing}
            onClose={() => setProposing(false)}
            title={t('propose.title')}
            description={
              recommended
                ? recommended.amount
                  ? t('propose.recommended', { kind: label(recommended.kind), amount: f.money(recommended.amount) })
                  : t('propose.recommendedKind', { kind: label(recommended.kind) })
                : t('propose.description')
            }
            onSubmit={(e) => {
              e.preventDefault();
              propose.mutate();
            }}
            footer={
              <Button type="submit" variant="primary" loading={propose.isPending}>
                {t('propose.submit')}
              </Button>
            }
          >
            <div className="stack">
              <Field label={w('kind')}>
                {(p) => (
                  <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {label(k)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('whatFailed')}>
                {(p) => (
                  <Select {...p} value={failureCode} onChange={(e) => setFailureCode(e.target.value)}>
                    {REASON_CODES.creditNoteCompensation.map((x) => (
                      <option key={x} value={x}>
                        {label(x)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {kind === 'credit' ? (
                <Field label={t('amountEgp')}>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
              ) : null}
              <Field label={w('note')} hint={t('noteStaff')}>
                {(p) => <Textarea {...p} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <ErrorAlert error={propose.error} />
            </div>
          </Dialog>
        </>
      ) : null}
    </QueryState>
  );
}
