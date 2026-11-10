'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Segmented, Select, useCommonT, useToast } from '@jiwar/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { keys, type StaffInvoiceKind } from '@/lib/queries';
import ar from '@/messages/ar/fin-dialogs';
import en from '@/messages/en/fin-dialogs';
import { useFinanceCode } from './codes';
import { KINDS, lineReady, linesTotal, validMoney } from './logic';

type Target = 'unit' | 'building' | 'all';
const TARGETS: readonly Target[] = ['unit', 'building', 'all'];
interface Line {
  descriptionEn: string;
  descriptionAr: string;
  amount: string;
}
const blank = (): Line => ({ descriptionEn: '', descriptionAr: '', amount: '' });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA');

/**
 * Issue an invoice (ADR 0046): the same lines to one unit, a building's
 * units or every unit, each invoice its own number. Invoices never change:
 * a mistake is corrected by a credit note.
 */
export function IssueDialog({ unitId: fixedUnit, onClose }: { unitId?: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const code = useFinanceCode();
  const toast = useToast();
  const [target, setTarget] = useState<Target>('unit');
  const [unitId, setUnitId] = useState(fixedUnit ?? '');
  const [building, setBuilding] = useState('');
  const [kind, setKind] = useState<StaffInvoiceKind>('service_charge');
  const [dueOn, setDueOn] = useState(inDays(14));
  const [lines, setLines] = useState<Line[]>([blank()]);
  const issue = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/invoices', {
          body: {
            target,
            ...(target === 'unit' ? { unitId } : target === 'building' ? { building: building.trim() } : {}),
            kind,
            dueOn,
            lines: lines.map((l) => ({ descriptionEn: l.descriptionEn.trim(), descriptionAr: l.descriptionAr.trim(), amount: l.amount.trim() })),
          },
        }),
      ),
    {
      invalidate: [keys.invoicesAll],
      onDone: (b) => {
        toast.show(
          b.unitCount === 1
            ? t('issue.doneOne', { number: b.firstNumber })
            : t('issue.doneMany', { count: b.unitCount, first: b.firstNumber, last: b.lastNumber }),
        );
        onClose();
      },
    },
  );
  const total = linesTotal(lines);
  const ready =
    lines.every(lineReady) &&
    total !== null &&
    Number(total) <= 1_000_000 &&
    dueOn !== '' &&
    (target === 'unit' ? unitId !== '' : target === 'building' ? building.trim() !== '' : true);
  const edit = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('issue.title')}
      description={t('issue.description')}
      onSubmit={() => ready && issue.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={issue.isPending} disabled={!ready}>
            {total ? t('issue.confirmEach', { amount: fmt.money(total) }) : t('issue.confirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        {fixedUnit ? null : (
          <Segmented<Target> label={t('issue.to')} value={target} onChange={setTarget} options={TARGETS.map((v) => ({ value: v, label: t(`target.${v}`) }))} />
        )}
        {target === 'unit' && !fixedUnit ? (
          <Field label={c('unit')} error={fieldError(issue.error, 'unitId')}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        ) : null}
        {target === 'building' ? (
          <Field label={c('building')} hint={t('issue.buildingHint')} error={fieldError(issue.error, 'building')}>
            {(p) => <Input {...p} maxLength={100} value={building} onChange={(e) => setBuilding(e.target.value)} />}
          </Field>
        ) : null}
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
        <Field label={t('issue.dueOn')} hint={t('issue.dueOnHint')} error={fieldError(issue.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" min={inDays(0)} max={inDays(366)} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
        </Field>
        {lines.map((l, i) => (
          <div key={i} className="stack stack--sm">
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label={t('issue.lineEn', { n: i + 1 })}>
                {(p) => <Input {...p} maxLength={200} dir="ltr" lang="en" value={l.descriptionEn} onChange={(e) => edit(i, { descriptionEn: e.target.value })} />}
              </Field>
              <Field label={t('issue.lineAr')}>
                {(p) => <Input {...p} maxLength={200} dir="rtl" lang="ar" value={l.descriptionAr} onChange={(e) => edit(i, { descriptionAr: e.target.value })} />}
              </Field>
              <Field label={t('issue.egp')} error={l.amount && !validMoney(l.amount) ? t('issue.invalidAmount') : undefined}>
                {(p) => <Input {...p} inputMode="decimal" value={l.amount} onChange={(e) => edit(i, { amount: e.target.value })} />}
              </Field>
              {lines.length > 1 ? (
                <Button aria-label={t('issue.removeLine', { n: i + 1 })} icon={<Trash2 aria-hidden />} onClick={() => setLines(lines.filter((_, j) => j !== i))} />
              ) : null}
            </div>
          </div>
        ))}
        {lines.length < 20 ? (
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setLines([...lines, blank()])}>
            {t('issue.addLine')}
          </Button>
        ) : null}
        <p className="t-secondary">{t('issue.total', { amount: total ? fmt.money(total) : '—' })}</p>
        <ErrorAlert error={issue.error} />
      </div>
    </Dialog>
  );
}
