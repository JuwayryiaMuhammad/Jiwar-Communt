'use client';

import { REASON_CODES, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, ReasonCodeDialog, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Compensation } from '@/lib/queries';
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
    { ...refresh, onDone: () => toast.show('The owner is named and told.') },
  );
  const close = useAction(
    (outcome: string) => unwrap(api.POST('/api/v1/staff/experience/cases/{id}/close', { params: { path: { id } }, body: { outcome } })),
    {
      ...refresh,
      onDone: () => {
        toast.show('The case is closed.');
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
        toast.show('Proposed: the manager decides it.');
        setProposing(false);
        setNote('');
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Case" />
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
            title={`${c.number} · ${c.unitCode ?? 'Unit'}`}
            description={`${humanize(c.kind)} · ${c.origin === 'signal' ? 'opened by a signal' : 'opened by the staff'} · ${
              c.dueAt ? `due ${formatDateTime(c.dueAt)}` : humanize(c.outcome ?? c.status)
            }`}
            actions={
              c.status === 'open' ? (
                <span className="row" style={{ gap: 6 }}>
                  <Button onClick={() => setProposing(true)}>Propose a compensation</Button>
                  <Button variant="primary" onClick={() => setClosing(true)}>
                    Close
                  </Button>
                </span>
              ) : null
            }
          />
          <Card>
            <div className="stack" style={{ padding: 12 }}>
              <span>
                <Badge>{humanize(c.status)}</Badge> {c.failureCode ? `What failed: ${humanize(c.failureCode)}` : null}
              </span>
              {c.note ? <p>{c.note}</p> : null}
              {c.status === 'open' ? (
                <div className="form__row">
                  <Field label="Owner (account id)" hint="An active staff or manager account; they are told.">
                    {(p) => <Input {...p} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={c.ownerId ?? ''} />}
                  </Field>
                  <Button loading={assign.isPending} disabled={!owner} onClick={() => assign.mutate()}>
                    Name owner
                  </Button>
                </div>
              ) : null}
              <ErrorAlert error={assign.error} />
            </div>
          </Card>
          <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
            Compensations
          </h2>
          <Card flush>
            <DataTable<Compensation>
              rows={c.compensations ?? []}
              rowKey={(x) => x.id}
              empty="None proposed"
              columns={[
                { key: 'at', header: 'Proposed', width: 170, cell: (x) => formatDateTime(x.proposedAt) },
                { key: 'kind', header: 'Kind', cell: (x) => `${humanize(x.kind)}${x.amount ? ` · ${x.amount} EGP` : ''}` },
                { key: 'failure', header: 'What failed', cell: (x) => humanize(x.failureCode) },
                { key: 'status', header: 'Status', cell: (x) => <Badge>{humanize(x.rejectReason ?? x.status)}</Badge> },
                { key: 'decide', header: '', cell: (x) => (can('experience.compensate') ? <CompensationDecision compensation={x} unitId={c.unitId} /> : null) },
              ]}
            />
          </Card>
          <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
            Signals
          </h2>
          <Card flush>
            <DataTable
              rows={c.signals ?? []}
              rowKey={(s) => s.id}
              empty="Opened by hand"
              columns={[
                { key: 'at', header: 'Detected', width: 170, cell: (s) => formatDateTime(s.detectedAt) },
                { key: 'rule', header: 'Rule', cell: (s) => humanize(s.code) },
                { key: 'count', header: 'Events', cell: (s) => `${s.count} in ${s.windowDays} days` },
              ]}
            />
          </Card>
          <ReasonCodeDialog
            open={closing}
            onClose={() => setClosing(false)}
            title={`Close ${c.number}?`}
            description="Once, with how it ended. Not while a compensation waits; compensated only with one approved."
            codes={REASON_CODES.experienceCaseOutcome}
            confirmLabel="Close case"
            pending={close.isPending}
            error={<ErrorAlert error={close.error} />}
            onConfirm={(code) => close.mutate(code)}
          />
          <Dialog
            open={proposing}
            onClose={() => setProposing(false)}
            title="Propose a compensation"
            description={
              recommended
                ? `The compound recommends ${humanize(recommended.kind)}${recommended.amount ? ` of ${recommended.amount} EGP` : ''} for this failure.`
                : 'A credit is issued through finance on one of the unit’s invoices when the manager approves it; above the board’s limit, with what the board approved.'
            }
            onSubmit={(e) => {
              e.preventDefault();
              propose.mutate();
            }}
            footer={
              <Button type="submit" variant="primary" loading={propose.isPending}>
                Propose
              </Button>
            }
          >
            <div className="stack">
              <Field label="Kind">
                {(p) => (
                  <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {humanize(k)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="What failed">
                {(p) => (
                  <Select {...p} value={failureCode} onChange={(e) => setFailureCode(e.target.value)}>
                    {REASON_CODES.creditNoteCompensation.map((x) => (
                      <option key={x} value={x}>
                        {humanize(x)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {kind === 'credit' ? (
                <Field label="Amount (EGP)">{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
              ) : null}
              <Field label="Note" hint="For the staff only.">
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
