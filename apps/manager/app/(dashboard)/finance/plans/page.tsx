'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { FREQUENCY_TEXT, KIND_TEXT, monthStarts, validMoney } from '@/components/finance/logic';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BillingOverride, type BillingPlan, type InvoiceKind } from '@/lib/queries';

const today = () => new Date().toLocaleDateString('en-CA');
type Frequency = BillingPlan['frequency'];
type AmountChange = Schema<'BillingAmountChangeView'>;
type Publication = Schema<'BoardPublicationView'>;

/** The board's published decisions a new amount may cite (ADR 0069): the manager's list. */
function useDecisions(enabled: boolean) {
  return useQuery({
    queryKey: ['governance', 'publications', 'decisions'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/governance/publications', { params: { query: { limit: 100 } } })),
    enabled,
  });
}

function PlanDialog({ plan, onClose }: { plan: BillingPlan | null; onClose: () => void }) {
  const toast = useToast();
  const { can } = usePermissions();
  const decisions = useDecisions(plan !== null && can('governance.manage'));
  const [descriptionEn, setDescriptionEn] = useState(plan?.descriptionEn ?? '');
  const [descriptionAr, setDescriptionAr] = useState(plan?.descriptionAr ?? '');
  const [decisionId, setDecisionId] = useState('');
  const [nameEn, setNameEn] = useState(plan?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(plan?.nameAr ?? '');
  const [kind, setKind] = useState<InvoiceKind>(plan?.kind ?? 'service_charge');
  const [frequency, setFrequency] = useState<Frequency>(plan?.frequency ?? 'monthly');
  const [amount, setAmount] = useState(plan?.amount ?? '');
  const starts = monthStarts(today());
  const [startsOn, setStartsOn] = useState(plan?.startsOn ?? starts[1] ?? starts[0]!);
  const [lead, setLead] = useState(String(plan?.issueDaysBefore ?? 5));
  const [due, setDue] = useState(String(plan?.dueDaysAfterIssue ?? 14));
  const save = useAction(
    () =>
      plan
        ? unwrap(
            api.PATCH('/api/v1/staff/billing-plans/{id}', {
              params: { path: { id: plan.id } },
              body: {
                nameEn: nameEn.trim(),
                nameAr: nameAr.trim(),
                amount: amount.trim(),
                issueDaysBefore: Number(lead),
                dueDaysAfterIssue: Number(due),
                descriptionEn: descriptionEn.trim() || null,
                descriptionAr: descriptionAr.trim() || null,
                ...(decisionId && amountChanged ? { decisionPublicationId: decisionId } : {}),
              },
            }),
          )
        : unwrap(
            api.POST('/api/v1/staff/billing-plans', {
              body: {
                nameEn: nameEn.trim(),
                nameAr: nameAr.trim(),
                kind,
                frequency,
                amount: amount.trim(),
                startsOn,
                issueDaysBefore: Number(lead),
                dueDaysAfterIssue: Number(due),
                ...(descriptionEn.trim() ? { descriptionEn: descriptionEn.trim(), descriptionAr: descriptionAr.trim() } : {}),
              },
            }),
          ),
    {
      invalidate: [keys.billingPlans],
      onDone: (p) => {
        toast.show(plan ? `${p.nameEn} is saved: periods issued from now on use it.` : `${p.nameEn} is created.`);
        onClose();
      },
    },
  );
  const int = (v: string, max: number) => /^\d+$/.test(v) && Number(v) <= max;
  const amountChanged = plan !== null && validMoney(amount) && Number(amount) !== Number(plan.amount);
  const described = (descriptionEn.trim() === '') === (descriptionAr.trim() === '');
  const ready = nameEn.trim() !== '' && nameAr.trim() !== '' && validMoney(amount) && int(lead, 28) && int(due, 90) && described;
  return (
    <Dialog
      open
      onClose={onClose}
      title={plan ? `Edit ${plan.nameEn}` : 'New billing plan'}
      description="A plan bills every unit of the compound the same amount each period, unless a unit has terms of its own. What it bills and how often never change once created."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name in English" hint="Each invoice’s line reads it, with the period." error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name in Arabic" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} maxLength={80} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        {plan ? null : (
          <>
            <Field label="Kind">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as InvoiceKind)}>
                  {Object.entries(KIND_TEXT).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Every">
              {(p) => (
                <Select {...p} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                  {Object.entries(FREQUENCY_TEXT).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="First period starts" error={fieldError(save.error, 'startsOn')}>
              {(p) => (
                <Select {...p} value={startsOn} onChange={(e) => setStartsOn(e.target.value)}>
                  {starts.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
        <Field label="Amount per unit, EGP" error={fieldError(save.error, 'amount') ?? (amount && !validMoney(amount) ? 'Up to two decimals, more than zero.' : undefined)}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        {amountChanged && decisions.data ? (
          <Field
            label="The board’s decision"
            hint="When the board set the new amount, the residents see its decision beside the change."
            error={fieldError(save.error, 'decisionPublicationId')}
          >
            {(p) => (
              <Select {...p} value={decisionId} onChange={(e) => setDecisionId(e.target.value)}>
                <option value="">None</option>
                {decisions.data.data
                  .filter((d: Publication) => d.kind === 'decision' && !d.archivedAt)
                  .map((d: Publication) => (
                    <option key={d.id} value={d.id}>
                      {d.decidedOn} · {d.titleEn}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field
          label="What it pays for, in English"
          hint="The residents it bills read it beside the fee. Both languages, or neither."
          error={fieldError(save.error, 'descriptionEn') ?? (!described ? 'Write it in both languages, or neither.' : undefined)}
        >
          {(p) => <Textarea {...p} maxLength={1000} rows={2} value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} />}
        </Field>
        <Field label="What it pays for, in Arabic" error={fieldError(save.error, 'descriptionAr')}>
          {(p) => <Textarea {...p} maxLength={1000} rows={2} dir="rtl" lang="ar" value={descriptionAr} onChange={(e) => setDescriptionAr(e.target.value)} />}
        </Field>
        <Field label="Issue, days before a period" hint="0 to 28." error={fieldError(save.error, 'issueDaysBefore')}>
          {(p) => <Input {...p} type="number" min={0} max={28} value={lead} onChange={(e) => setLead(e.target.value)} />}
        </Field>
        <Field label="Due, days after issue" hint="0 to 90." error={fieldError(save.error, 'dueDaysAfterIssue')}>
          {(p) => <Input {...p} type="number" min={0} max={90} value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Overrides({ plan, canEdit, onClose }: { plan: BillingPlan; canEdit: boolean; onClose: () => void }) {
  const toast = useToast();
  const list = useQuery({ queryKey: keys.billingOverrides(plan.id), queryFn: () => fetchers.billingOverrides(plan.id) });
  const [unitId, setUnitId] = useState('');
  const [amount, setAmount] = useState('');
  const [excluded, setExcluded] = useState(false);
  const set = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/staff/billing-plans/{id}/overrides/{unitId}', {
          params: { path: { id: plan.id, unitId } },
          body: excluded ? { excluded: true } : { amount: amount.trim() },
        }),
      ),
    {
      invalidate: [keys.billingOverrides(plan.id), keys.billingPlans],
      onDone: (o) => {
        toast.show(o.excluded ? `Unit ${o.unitCode} is left out.` : `Unit ${o.unitCode} pays ${egp(o.amount)}.`);
        setUnitId('');
        setAmount('');
        setExcluded(false);
      },
    },
  );
  const remove = useAction(
    (u: BillingOverride) =>
      unwrap(api.DELETE('/api/v1/staff/billing-plans/{id}/overrides/{unitId}', { params: { path: { id: plan.id, unitId: u.unitId } } })),
    { invalidate: [keys.billingOverrides(plan.id), keys.billingPlans], onDone: () => toast.show('Back on the plan’s own terms.') },
  );
  const ready = unitId !== '' && (excluded || validMoney(amount));
  return (
    <Dialog open wide onClose={onClose} title={`Units with their own terms · ${plan.nameEn}`} description={`Everyone else pays ${egp(plan.amount)} each period.`} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        {canEdit ? (
          <div className="form">
            <Field label="Unit">{(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}</Field>
            <Checkbox label="Leave this unit out" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} />
            {excluded ? null : (
              <Field label="Its amount, EGP" error={amount && !validMoney(amount) ? 'Up to two decimals, more than zero.' : undefined}>
                {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
            )}
            <Button variant="primary" disabled={!ready} loading={set.isPending} onClick={() => set.mutate()}>
              Save the unit’s terms
            </Button>
            <ErrorAlert error={set.error ?? remove.error} />
          </div>
        ) : null}
        <Card flush>
          <QueryState query={list}>
            <DataTable<BillingOverride>
              rows={list.data?.data}
              rowKey={(o) => o.unitId}
              empty="Every unit is on the plan’s terms"
              columns={[
                { key: 'unit', header: 'Unit', cell: (o) => <span className="t-mono">{o.unitCode}</span> },
                { key: 'terms', header: 'Terms', cell: (o) => (o.excluded ? <Badge tone="beige">Left out</Badge> : egp(o.amount)) },
                {
                  key: 'actions',
                  header: '',
                  className: 'table__actions',
                  cell: (o) =>
                    canEdit ? (
                      <Button size="sm" loading={remove.isPending && remove.variables?.unitId === o.unitId} onClick={() => remove.mutate(o)}>
                        Remove
                      </Button>
                    ) : null,
                },
              ]}
            />
          </QueryState>
        </Card>
      </div>
    </Dialog>
  );
}

/** A plan's amount changes, the latest first (ADR 0069). */
function AmountChanges({ plan, onClose }: { plan: BillingPlan; onClose: () => void }) {
  const list = useQuery({
    queryKey: [...keys.billingPlans, plan.id, 'amount-changes'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/billing-plans/{id}/amount-changes', { params: { path: { id: plan.id } } })),
  });
  return (
    <Dialog open onClose={onClose} title={`${plan.nameEn}: amount changes`} description="Each new amount, the first period billed at it, and the board’s decision when one set it.">
      <Card flush>
        <QueryState query={list}>
          <DataTable<AmountChange>
            rows={list.data?.data}
            rowKey={(c) => c.id}
            empty="Its amount never changed"
            columns={[
              { key: 'from', header: 'From', cell: (c) => egp(c.fromAmount) },
              { key: 'to', header: 'To', cell: (c) => egp(c.toAmount) },
              { key: 'on', header: 'From the period of', cell: (c) => c.effectiveOn },
              { key: 'd', header: 'Decision', cell: (c) => (c.decisionPublicationId ? <Badge tone="green">Board</Badge> : '—') },
            ]}
          />
        </QueryState>
      </Card>
    </Dialog>
  );
}

/**
 * Recurring billing (ADR 0046): each plan bills every unit each period,
 * issued automatically; units may have their own amount or be left out.
 * Kept by `finance.billing`; read by those who issue invoices.
 */
export default function BillingPlansPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const canEdit = can('finance.billing');
  const allowed = canEdit || can('finance.invoice');
  const plans = useQuery({ queryKey: keys.billingPlans, queryFn: fetchers.billingPlans, enabled: allowed });
  const [open, setOpen] = useState<{ plan: BillingPlan | null } | null>(null);
  const [terms, setTerms] = useState<BillingPlan | null>(null);
  const [history, setHistory] = useState<BillingPlan | null>(null);
  const setActive = useAction(
    (p: BillingPlan) => unwrap(api.PATCH('/api/v1/staff/billing-plans/{id}', { params: { path: { id: p.id } }, body: { active: !p.active } })),
    { invalidate: [keys.billingPlans], onDone: (p) => toast.show(p.active ? `${p.nameEn} bills again.` : `${p.nameEn} is retired: it bills nothing more.`) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Billing plans" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Billing plans"
        description="Invoices issued every period to every unit, automatically. Each unit’s people who see its money are told."
        actions={
          canEdit ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ plan: null })}>
              New plan
            </Button>
          ) : undefined
        }
      />
      <ErrorAlert error={setActive.error} />
      <Card flush>
        <QueryState query={plans}>
          <DataTable<BillingPlan>
            rows={plans.data?.data}
            rowKey={(p) => p.id}
            empty="No plan yet"
            columns={[
              {
                key: 'name',
                header: 'Plan',
                cell: (p) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{p.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {p.nameAr}
                    </span>
                    {!p.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (p) => KIND_TEXT[p.kind] ?? p.kind },
              { key: 'every', header: 'Every', cell: (p) => FREQUENCY_TEXT[p.frequency] ?? p.frequency },
              {
                key: 'amount',
                header: 'Per unit',
                cell: (p) => (
                  <Button variant="text" className="table__link" onClick={() => setHistory(p)}>
                    {egp(p.amount)}
                  </Button>
                ),
              },
              { key: 'next', header: 'Next period', cell: (p) => (p.nextPeriod ? `${p.nextPeriod.startsOn} · issued ${p.nextPeriod.issueOn}` : '—') },
              {
                key: 'own',
                header: 'Own terms',
                cell: (p) => (
                  <Button variant="text" className="table__link" onClick={() => setTerms(p)}>
                    {p.overrideCount} unit{p.overrideCount === 1 ? '' : 's'}
                  </Button>
                ),
              },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (p) =>
                  canEdit ? (
                    <span className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <Button size="sm" onClick={() => setOpen({ plan: p })}>
                        Edit
                      </Button>
                      <Button size="sm" loading={setActive.isPending && setActive.variables?.id === p.id} onClick={() => setActive.mutate(p)}>
                        {p.active ? 'Retire' : 'Restore'}
                      </Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <PlanDialog key={open.plan?.id ?? 'new'} plan={open.plan} onClose={() => setOpen(null)} /> : null}
      {terms ? <Overrides plan={terms} canEdit={canEdit} onClose={() => setTerms(null)} /> : null}
      {history ? <AmountChanges plan={history} onClose={() => setHistory(null)} /> : null}
    </>
  );
}
