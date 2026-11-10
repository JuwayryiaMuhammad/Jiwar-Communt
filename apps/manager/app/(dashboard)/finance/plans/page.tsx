'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useFinanceCode } from '@/components/finance/codes';
import { FREQUENCIES, KINDS, monthStarts, validMoney } from '@/components/finance/logic';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BillingOverride, type BillingPlan, type StaffInvoiceKind } from '@/lib/queries';
import ar from '@/messages/ar/fin-plans';
import en from '@/messages/en/fin-plans';

const today = () => new Date().toLocaleDateString('en-CA');
type Frequency = BillingPlan['frequency'];
type AmountChange = Schema<'BillingAmountChangeView'>;
type Publication = Schema<'BoardPublicationView'>;

/** A plan's name in the page's language (it carries both). */
function usePlanName() {
  const { locale } = useLocale();
  return (p: { nameEn: string; nameAr: string }) => (locale === 'ar' ? p.nameAr || p.nameEn : p.nameEn);
}

/** The board's published decisions a new amount may cite (ADR 0069): the manager's list. */
function useDecisions(enabled: boolean) {
  return useQuery({
    queryKey: ['governance', 'publications', 'decisions'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/governance/publications', { params: { query: { limit: 100 } } })),
    enabled,
  });
}

function PlanDialog({ plan, onClose }: { plan: BillingPlan | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const { locale } = useLocale();
  const code = useFinanceCode();
  const name = usePlanName();
  const toast = useToast();
  const { can } = usePermissions();
  const decisions = useDecisions(plan !== null && can('governance.manage'));
  const [descriptionEn, setDescriptionEn] = useState(plan?.descriptionEn ?? '');
  const [descriptionAr, setDescriptionAr] = useState(plan?.descriptionAr ?? '');
  const [decisionId, setDecisionId] = useState('');
  const [nameEn, setNameEn] = useState(plan?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(plan?.nameAr ?? '');
  const [kind, setKind] = useState<StaffInvoiceKind>((plan?.kind as StaffInvoiceKind | undefined) ?? 'service_charge');
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
        toast.show(plan ? t('saved', { name: name(p) }) : t('created', { name: name(p) }));
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
      title={plan ? t('editTitle', { name: name(plan) }) : t('newTitle')}
      description={t('dialogDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('nameEn')} hint={t('nameEnHint')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={80} dir="ltr" lang="en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} maxLength={80} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        {plan ? null : (
          <>
            <Field label={c('kind')}>
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as StaffInvoiceKind)}>
                  {KINDS.map((v) => (
                    <option key={v} value={v}>
                      {code('kind', v)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('every')}>
              {(p) => (
                <Select {...p} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                  {FREQUENCIES.map((v) => (
                    <option key={v} value={v}>
                      {code('frequency', v)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('firstPeriod')} error={fieldError(save.error, 'startsOn')}>
              {(p) => (
                <Select {...p} value={startsOn} onChange={(e) => setStartsOn(e.target.value)}>
                  {starts.map((d) => (
                    <option key={d} value={d}>
                      {fmt.day(d)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
        <Field label={t('amount')} error={fieldError(save.error, 'amount') ?? (amount && !validMoney(amount) ? t('amountInvalid') : undefined)}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        {amountChanged && decisions.data ? (
          <Field label={t('decision')} hint={t('decisionHint')} error={fieldError(save.error, 'decisionPublicationId')}>
            {(p) => (
              <Select {...p} value={decisionId} onChange={(e) => setDecisionId(e.target.value)}>
                <option value="">{c('none')}</option>
                {decisions.data.data
                  .filter((d: Publication) => d.kind === 'decision' && !d.archivedAt)
                  .map((d: Publication) => (
                    <option key={d.id} value={d.id}>
                      {fmt.day(d.decidedOn)} · {(locale === 'ar' ? d.titleAr : d.titleEn) ?? d.titleEn ?? d.titleAr}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={t('forEn')} hint={t('forEnHint')} error={fieldError(save.error, 'descriptionEn') ?? (!described ? t('bothOrNeither') : undefined)}>
          {(p) => <Textarea {...p} maxLength={1000} rows={2} dir="ltr" lang="en" value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} />}
        </Field>
        <Field label={t('forAr')} error={fieldError(save.error, 'descriptionAr')}>
          {(p) => <Textarea {...p} maxLength={1000} rows={2} dir="rtl" lang="ar" value={descriptionAr} onChange={(e) => setDescriptionAr(e.target.value)} />}
        </Field>
        <Field label={t('lead')} hint={t('leadHint')} error={fieldError(save.error, 'issueDaysBefore')}>
          {(p) => <Input {...p} type="number" min={0} max={28} value={lead} onChange={(e) => setLead(e.target.value)} />}
        </Field>
        <Field label={t('due')} hint={t('dueHint')} error={fieldError(save.error, 'dueDaysAfterIssue')}>
          {(p) => <Input {...p} type="number" min={0} max={90} value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Overrides({ plan, canEdit, onClose }: { plan: BillingPlan; canEdit: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const name = usePlanName();
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
        toast.show(o.excluded ? t('leftOutToast', { unit: o.unitCode }) : t('paysToast', { unit: o.unitCode, amount: fmt.money(o.amount) }));
        setUnitId('');
        setAmount('');
        setExcluded(false);
      },
    },
  );
  const remove = useAction(
    (u: BillingOverride) =>
      unwrap(api.DELETE('/api/v1/staff/billing-plans/{id}/overrides/{unitId}', { params: { path: { id: plan.id, unitId: u.unitId } } })),
    { invalidate: [keys.billingOverrides(plan.id), keys.billingPlans], onDone: () => toast.show(t('backOnTerms')) },
  );
  const ready = unitId !== '' && (excluded || validMoney(amount));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('overridesTitle', { name: name(plan) })}
      description={t('overridesDescription', { amount: fmt.money(plan.amount) })}
      footer={<Button onClick={onClose}>{c('close')}</Button>}
    >
      <div className="stack">
        {canEdit ? (
          <div className="form">
            <Field label={c('unit')}>{(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}</Field>
            <Checkbox label={t('leaveOut')} checked={excluded} onChange={(e) => setExcluded(e.target.checked)} />
            {excluded ? null : (
              <Field label={t('itsAmount')} error={amount && !validMoney(amount) ? t('amountInvalid') : undefined}>
                {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
            )}
            <Button variant="primary" disabled={!ready} loading={set.isPending} onClick={() => set.mutate()}>
              {t('saveTerms')}
            </Button>
            <ErrorAlert error={set.error ?? remove.error} />
          </div>
        ) : null}
        <Card flush>
          <QueryState query={list}>
            <DataTable<BillingOverride>
              rows={list.data?.data}
              rowKey={(o) => o.unitId}
              empty={t('noOverride')}
              columns={[
                { key: 'unit', header: c('unit'), cell: (o) => <span className="t-mono">{o.unitCode}</span> },
                { key: 'terms', header: t('col.terms'), cell: (o) => (o.excluded ? <Badge tone="beige">{t('leftOut')}</Badge> : fmt.money(o.amount)) },
                {
                  key: 'actions',
                  header: '',
                  className: 'table__actions',
                  cell: (o) =>
                    canEdit ? (
                      <Button size="sm" loading={remove.isPending && remove.variables?.unitId === o.unitId} onClick={() => remove.mutate(o)}>
                        {c('remove')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const name = usePlanName();
  const list = useQuery({
    queryKey: [...keys.billingPlans, plan.id, 'amount-changes'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/billing-plans/{id}/amount-changes', { params: { path: { id: plan.id } } })),
  });
  return (
    <Dialog open onClose={onClose} title={t('changesTitle', { name: name(plan) })} description={t('changesDescription')}>
      <Card flush>
        <QueryState query={list}>
          <DataTable<AmountChange>
            rows={list.data?.data}
            rowKey={(x) => x.id}
            empty={t('noChange')}
            columns={[
              { key: 'from', header: c('from'), cell: (x) => fmt.money(x.fromAmount) },
              { key: 'to', header: c('to'), cell: (x) => fmt.money(x.toAmount) },
              { key: 'on', header: t('col.fromPeriod'), cell: (x) => fmt.day(x.effectiveOn) },
              { key: 'd', header: t('col.decision'), cell: (x) => (x.decisionPublicationId ? <Badge tone="green">{t('board')}</Badge> : '—') },
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const code = useFinanceCode();
  const name = usePlanName();
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
    { invalidate: [keys.billingPlans], onDone: (p) => toast.show(p.active ? t('billsAgain', { name: name(p) }) : t('retiredToast', { name: name(p) })) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canEdit ? (
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ plan: null })}>
              {t('newPlan')}
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
            empty={t('empty')}
            columns={[
              {
                key: 'name',
                header: t('col.plan'),
                cell: (p) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary" dir="ltr" lang="en">
                      {p.nameEn}
                    </span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {p.nameAr}
                    </span>
                    {!p.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'kind', header: c('kind'), cell: (p) => code('kind', p.kind) },
              { key: 'every', header: t('col.every'), cell: (p) => code('frequency', p.frequency) },
              {
                key: 'amount',
                header: t('col.perUnit'),
                cell: (p) => (
                  <Button variant="text" className="table__link" onClick={() => setHistory(p)}>
                    {fmt.money(p.amount)}
                  </Button>
                ),
              },
              {
                key: 'next',
                header: t('col.next'),
                cell: (p) => (p.nextPeriod ? t('next', { starts: fmt.day(p.nextPeriod.startsOn), issued: fmt.day(p.nextPeriod.issueOn) }) : '—'),
              },
              {
                key: 'own',
                header: t('col.ownTerms'),
                cell: (p) => (
                  <Button variant="text" className="table__link" onClick={() => setTerms(p)}>
                    {t('units', { n: p.overrideCount })}
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
                        {c('edit')}
                      </Button>
                      <Button size="sm" loading={setActive.isPending && setActive.variables?.id === p.id} onClick={() => setActive.mutate(p)}>
                        {p.active ? t('retire') : t('restore')}
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
