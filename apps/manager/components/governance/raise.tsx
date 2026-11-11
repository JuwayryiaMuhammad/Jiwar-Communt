'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { codeText } from '@/components/governance/logic';
import { APPROVAL_SUBJECT, APPROVAL_TYPES } from '@/components/governance/matters';
import { AccountPicker } from '@/components/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ApprovalType } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-ui';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-ui';
import codesEn from '@/messages/en/gov-codes';

const MAX_ALTERNATIVES = 5;
const MAX_ATTACHMENTS = 5;

/**
 * Raises a matter for the board (ADR 0055): its context and impact, the
 * cost, up to five alternatives and five attachments. An annual budget is
 * raised from its own page (`budgetId` given): its cost is its total. A
 * budget increase names a line of the active budget. A budget transfer
 * above the manager's limit is raised from its own page too
 * (`budgetTransferId`): its amount is its cost (ADR 0089). A year's capital
 * plan (ADR 0086) is raised from its own page too (`capitalPlanId`): its
 * total.
 */
export function RaiseApproval({
  onClose,
  budgetId,
  budgetTransferId,
  capitalPlanId,
}: {
  onClose: () => void;
  budgetId?: string;
  budgetTransferId?: string;
  capitalPlanId?: string;
}) {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const router = useRouter();
  const { can } = usePermissions();
  const [key] = useState(() => crypto.randomUUID());
  const [type, setType] = useState<ApprovalType>(
    budgetId ? 'annual_budget' : budgetTransferId ? 'budget_transfer' : capitalPlanId ? 'capital_plan' : 'major_contract',
  );
  const [lineId, setLineId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [context, setContext] = useState('');
  const [impact, setImpact] = useState('');
  const [cost, setCost] = useState('');
  const [alternatives, setAlternatives] = useState<{ text: string; cost: string }[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const subject = APPROVAL_SUBJECT[type];
  const active = useQuery({
    queryKey: keys.budgets('active'),
    queryFn: () => fetchers.budgets('active', undefined, 1),
    enabled: subject === 'budget_line',
  });
  const lines = active.data?.data[0]?.lines ?? [];
  // ADR 0075: the board approves a manager leaving without a handover.
  const types = (APPROVAL_TYPES as ApprovalType[]).filter(
    (x) =>
      x !== 'annual_budget' && x !== 'budget_transfer' && x !== 'capital_plan' && (x !== 'budget_increase' || can('finance.budget')),
  );
  const raise = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/governance/approvals', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            type,
            context: context.trim(),
            impact: impact.trim(),
            ...(subject === 'budget' && budgetId ? { budgetId } : {}),
            ...(subject === 'budget_line' && lineId ? { budgetLineId: lineId } : {}),
            ...(subject === 'manager' && managerId ? { managerAccountId: managerId } : {}),
            ...(subject === 'budget_transfer' && budgetTransferId ? { budgetTransferId } : {}),
            ...(subject === 'capital_plan' && capitalPlanId ? { capitalPlanId } : {}),
            ...(type !== 'annual_budget' && type !== 'budget_transfer' && type !== 'capital_plan' && cost.trim()
              ? { cost: cost.trim() }
              : {}),
            ...(alternatives.length
              ? { alternatives: alternatives.map((a) => ({ text: a.text.trim(), ...(a.cost.trim() ? { cost: a.cost.trim() } : {}) })) }
              : {}),
            ...(files.length ? { attachmentIds: files } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll, keys.budgetsAll, keys.capitalPlansAll],
      onDone: (r) => {
        toast.show(t('raisedToast'));
        onClose();
        router.push(`/governance/approvals/${r.id}`);
      },
    },
  );
  const err = (f: string) => fieldError(raise.error, f);
  const ready =
    context.trim() &&
    impact.trim() &&
    (subject !== 'budget_line' || lineId) &&
    (subject !== 'manager' || managerId) &&
    alternatives.every((a) => a.text.trim());
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={budgetId ? t('titleBudget') : capitalPlanId ? t('titlePlan') : t('titleRaise')}
      description={t('raiseDescription')}
      onSubmit={() => raise.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={raise.isPending} disabled={!ready}>
            {budgetId || budgetTransferId || capitalPlanId ? t('submit') : t('raise')}
          </Button>
        </>
      }
    >
      <div className="form">
        {budgetId || budgetTransferId || capitalPlanId ? null : (
          <Field label={c('type')} error={err('type')}>
            {(p) => (
              <Select {...p} value={type} onChange={(e) => setType(e.target.value as ApprovalType)}>
                {types.map((x) => (
                  <option key={x} value={x}>
                    {codeText(g, 'approvalType', x)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {subject === 'manager' ? (
          <Field label={t('manager')} hint={t('managerHint')} error={err('managerAccountId')}>
            {(p) => (
              <AccountPicker {...p} group="managers" placeholder={t('chooseManager')} value={managerId} onChange={(id) => setManagerId(id)} />
            )}
          </Field>
        ) : null}
        {subject === 'budget_line' ? (
          <Field label={t('line')} error={err('budgetLineId')}>
            {(p) => (
              <Select {...p} value={lineId} onChange={(e) => setLineId(e.target.value)}>
                <option value="">{active.isPending ? t('loading') : lines.length ? t('chooseLine') : t('noActiveBudget')}</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {t('lineLeft', {
                      category: codeText(g, 'category', l.category),
                      remaining: fmt.number(l.remaining),
                      allowance: fmt.number(l.allowance),
                    })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={t('context')} error={err('context')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={context} onChange={(e) => setContext(e.target.value)} />}
        </Field>
        <Field label={t('impact')} error={err('impact')}>
          {(p) => <Textarea {...p} rows={3} maxLength={2000} value={impact} onChange={(e) => setImpact(e.target.value)} />}
        </Field>
        {type === 'annual_budget' || type === 'capital_plan' ? (
          <p className="t-secondary">{t('costIsTotal', { kind: type })}</p>
        ) : type === 'budget_transfer' ? (
          <p className="t-secondary">{t('costIsTransfer')}</p>
        ) : (
          <Field label={type === 'budget_increase' || type === 'major_contract' ? t('costRequired') : t('costOptional')} error={err('cost')}>
            {(p) => <Input {...p} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />}
          </Field>
        )}
        <div className="stack">
          <span>{t('alternatives')}</span>
          {alternatives.map((a, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label={t('alternativeN', { n: i + 1 })} error={err(`alternatives.${i}.text`)}>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={1000}
                    value={a.text}
                    onChange={(e) => setAlternatives(alternatives.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                )}
              </Field>
              <Field label={t('alternativeCost')} error={err(`alternatives.${i}.cost`)}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={a.cost}
                    onChange={(e) => setAlternatives(alternatives.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))}
                  />
                )}
              </Field>
              <Button variant="text" onClick={() => setAlternatives(alternatives.filter((_, j) => j !== i))}>
                {c('remove')}
              </Button>
            </div>
          ))}
          {alternatives.length < MAX_ALTERNATIVES ? (
            <Button variant="text" onClick={() => setAlternatives([...alternatives, { text: '', cost: '' }])}>
              {t('addAlternative')}
            </Button>
          ) : null}
        </div>
        {files.length ? <p className="t-secondary">{t('attached', { n: files.length })}</p> : null}
        <FileUpload
          purpose="approval_attachment"
          label={t('attach')}
          disabled={files.length >= MAX_ATTACHMENTS}
          onUploaded={(id) => setFiles((f) => [...f, id])}
        />
        {err('attachmentIds') ? <p className="t-error">{err('attachmentIds')}</p> : null}
        {err('budgetId') ? <p className="t-error">{err('budgetId')}</p> : null}
        <ErrorAlert error={raise.error} />
      </div>
    </Dialog>
  );
}
