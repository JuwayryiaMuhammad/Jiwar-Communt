'use client';

import { fieldError } from '@jiwar/api';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Field, Input, Select, useLabel } from '@jiwar/ui';
import { Trash2 } from 'lucide-react';
import type { StockItem } from '@/lib/queries';
import ar from '@/messages/ar/po-common';
import en from '@/messages/en/po-common';
import {
  fromCents,
  lineNet,
  LINE_KINDS,
  MAX_DESCRIPTION,
  MAX_LINES,
  newLine,
  orderTotals,
  TAX_CODES,
  UNITS,
  WITHHOLDING,
  type FormLine,
  type TaxCode,
  type Unit,
  type Withholding,
} from './po';

/** The three totals of an order's lines, as they will be computed. */
export function TotalsLine({ lines }: { lines: readonly FormLine[] }) {
  const t = useT(en, ar);
  const f = useFormat();
  const totals = orderTotals(lines);
  return (
    <p className="row" style={{ gap: 24, flexWrap: 'wrap' }} aria-live="polite">
      <span>
        <span className="t-secondary">{t('totals.net')}</span> <strong className="t-mono">{f.money(totals.subtotal)}</strong>
      </span>
      <span>
        <span className="t-secondary">{t('totals.vat')}</span> <strong className="t-mono">{f.money(totals.tax)}</strong>
      </span>
      <span>
        <span className="t-secondary">{t('totals.total')}</span> <strong className="t-mono">{f.money(totals.total)}</strong>
      </span>
    </p>
  );
}

/**
 * The lines of an order (raising it and amending it): add and remove, a kind
 * each, a stock item whose unit the line takes, description, quantity, unit,
 * net unit price, VAT code and the withholding category, with the totals the
 * API will compute. An existing line (an amendment) keeps its id.
 */
export function LinesEditor({
  lines,
  onChange,
  items,
  stockAllowed,
  error,
}: {
  lines: FormLine[];
  onChange: (next: FormLine[]) => void;
  items: readonly StockItem[];
  /** Whether the caller can list stock items at all. */
  stockAllowed: boolean;
  error: unknown;
}) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const set = (i: number, patch: Partial<FormLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const err = (i: number, field: string) => fieldError(error, `lines.${i}.${field}`);
  const itemName = (it: StockItem) => (f.locale === 'ar' ? it.nameAr : it.nameEn);
  return (
    <div className="stack">
      {lines.map((l, i) => {
        const item = items.find((x) => x.id === l.stockItemId);
        const net = lineNet(l.quantity, l.unitPrice);
        return (
          <div key={l.key} className="stack stack--sm" style={{ borderBlockEnd: '1px solid var(--hairline-soft)', paddingBlockEnd: 12 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label={t('lines.kind')} error={err(i, 'kind')}>
                {(p) => (
                  <Select
                    {...p}
                    value={l.kind}
                    onChange={(e) => set(i, { kind: e.target.value as FormLine['kind'], stockItemId: '' })}
                  >
                    {LINE_KINDS.filter((k) => k !== 'stock' || stockAllowed || l.kind === 'stock').map((k) => (
                      <option key={k} value={k}>
                        {t(`kind.${k}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {l.kind === 'stock' ? (
                <Field label={t('lines.item')} error={err(i, 'stockItemId')}>
                  {(p) => (
                    <Select
                      {...p}
                      value={l.stockItemId}
                      onChange={(e) => {
                        const picked = items.find((x) => x.id === e.target.value);
                        set(i, { stockItemId: e.target.value, ...(picked ? { unit: picked.unit as Unit } : {}) });
                      }}
                    >
                      <option value="">{t('lines.chooseItem')}</option>
                      {l.stockItemId && !item ? <option value={l.stockItemId}>{l.description || l.stockItemId}</option> : null}
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {`${it.sku} · ${itemName(it)}`}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : (
                <Field label={t('lines.description')} error={err(i, 'description')}>
                  {(p) => <Input {...p} maxLength={MAX_DESCRIPTION} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />}
                </Field>
              )}
              <Field label={t('lines.quantity')} error={err(i, 'quantity')}>
                {(p) => (
                  <Input {...p} inputMode="decimal" className="ltr" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
                )}
              </Field>
              {l.kind === 'stock' ? (
                item ? <span className="t-secondary">{t('lines.unitOfItem', { unit: label(item.unit) })}</span> : null
              ) : (
                <Field label={t('lines.unit')} error={err(i, 'unit')}>
                  {(p) => (
                    <Select {...p} value={l.unit} onChange={(e) => set(i, { unit: e.target.value as Unit })}>
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {label(u)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label={t('lines.unitPrice')} error={err(i, 'unitPrice')}>
                {(p) => (
                  <Input {...p} inputMode="decimal" className="ltr" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} />
                )}
              </Field>
              <Field label={t('lines.vat')} error={err(i, 'taxCode')}>
                {(p) => (
                  <Select {...p} value={l.taxCode} onChange={(e) => set(i, { taxCode: e.target.value as TaxCode })}>
                    {TAX_CODES.map((c) => (
                      <option key={c} value={c}>
                        {t(`tax.${c}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('lines.withholding')} error={err(i, 'withholdingCategory')}>
                {(p) => (
                  <Select {...p} value={l.withholding} onChange={(e) => set(i, { withholding: e.target.value as '' | Withholding })}>
                    <option value="">{t('lines.withholdingDefault')}</option>
                    {WITHHOLDING.map((w) => (
                      <option key={w} value={w}>
                        {label(w)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button
                size="sm"
                variant="text"
                iconOnly
                icon={<Trash2 aria-hidden />}
                aria-label={t('lines.remove')}
                disabled={lines.length <= 1}
                onClick={() => onChange(lines.filter((_, j) => j !== i))}
              />
            </div>
            {net !== null ? <span className="t-secondary">{t('lines.lineTotal', { net: f.money(fromCents(net)) })}</span> : null}
          </div>
        );
      })}
      {!stockAllowed ? <p className="hint">{t('lines.noStockAccess')}</p> : null}
      <div>
        <Button size="sm" disabled={lines.length >= MAX_LINES} onClick={() => onChange([...lines, newLine('goods')])}>
          {t('lines.add')}
        </Button>
      </div>
      <TotalsLine lines={lines} />
    </div>
  );
}
