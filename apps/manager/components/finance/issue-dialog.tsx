'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Segmented, Select, useToast } from '@jiwar/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { egp } from '@/components/club/logic';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { keys, type InvoiceKind } from '@/lib/queries';
import { KIND_TEXT, lineReady, linesTotal, validMoney } from './logic';

type Target = 'unit' | 'building' | 'all';
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
  const toast = useToast();
  const [target, setTarget] = useState<Target>('unit');
  const [unitId, setUnitId] = useState(fixedUnit ?? '');
  const [building, setBuilding] = useState('');
  const [kind, setKind] = useState<InvoiceKind>('service_charge');
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
            ? `Issued ${b.firstNumber}. The unit is told.`
            : `Issued ${b.unitCount} invoices, ${b.firstNumber} to ${b.lastNumber}. The units are told.`,
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
      title="Issue invoices"
      description="Invoices never change once issued; a mistake is corrected by a credit note. Each unit’s people who see its money are told."
      onSubmit={() => ready && issue.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={issue.isPending} disabled={!ready}>
            Issue{total ? ` · ${egp(total)} each` : ''}
          </Button>
        </>
      }
    >
      <div className="form">
        {fixedUnit ? null : (
          <Segmented<Target>
            label="To"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'unit', label: 'One unit' },
              { value: 'building', label: 'A building' },
              { value: 'all', label: 'Every unit' },
            ]}
          />
        )}
        {target === 'unit' && !fixedUnit ? (
          <Field label="Unit" error={fieldError(issue.error, 'unitId')}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        ) : null}
        {target === 'building' ? (
          <Field label="Building" hint="Units whose building reads exactly this." error={fieldError(issue.error, 'building')}>
            {(p) => <Input {...p} maxLength={100} value={building} onChange={(e) => setBuilding(e.target.value)} />}
          </Field>
        ) : null}
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
        <Field label="Due on" hint="From today to a year ahead." error={fieldError(issue.error, 'dueOn')}>
          {(p) => <Input {...p} type="date" min={inDays(0)} max={inDays(366)} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
        </Field>
        {lines.map((l, i) => (
          <div key={i} className="stack stack--sm">
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label={`Line ${i + 1} · English`}>
                {(p) => <Input {...p} maxLength={200} value={l.descriptionEn} onChange={(e) => edit(i, { descriptionEn: e.target.value })} />}
              </Field>
              <Field label="Arabic">
                {(p) => <Input {...p} maxLength={200} dir="rtl" lang="ar" value={l.descriptionAr} onChange={(e) => edit(i, { descriptionAr: e.target.value })} />}
              </Field>
              <Field label="EGP" error={l.amount && !validMoney(l.amount) ? 'Invalid amount.' : undefined}>
                {(p) => <Input {...p} inputMode="decimal" value={l.amount} onChange={(e) => edit(i, { amount: e.target.value })} />}
              </Field>
              {lines.length > 1 ? (
                <Button aria-label={`Remove line ${i + 1}`} icon={<Trash2 aria-hidden />} onClick={() => setLines(lines.filter((_, j) => j !== i))} />
              ) : null}
            </div>
          </div>
        ))}
        {lines.length < 20 ? (
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => setLines([...lines, blank()])}>
            Add a line
          </Button>
        ) : null}
        <p className="t-secondary">Total per invoice: {total ? egp(total) : '—'}</p>
        <ErrorAlert error={issue.error} />
      </div>
    </Dialog>
  );
}
