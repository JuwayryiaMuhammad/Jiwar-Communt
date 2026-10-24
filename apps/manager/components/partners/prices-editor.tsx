'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Button, Card, CardBody, CardHeader, Input, Select, useToast } from '@jiwar/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type PartnerPriceUnit, type StaffPartner } from '@/lib/queries';
import { PRICE_UNIT_TEXT, validPrice } from './logic';

interface Line {
  nameEn: string;
  nameAr: string;
  price: string;
  unit: PartnerPriceUnit;
  subcategoryId: string;
}

const linesOf = (p: StaffPartner): Line[] =>
  p.priceItems.map((i) => ({
    nameEn: i.nameEn,
    nameAr: i.nameAr,
    price: i.price,
    unit: i.unit,
    subcategoryId: i.subcategoryId ?? '',
  }));

/**
 * A partner's announced price list (ADR 0060), in EGP, replaced as a whole
 * and in order. Paid to the partner, never through the platform. A request
 * keeps its own copy of the lines it named, whatever the list becomes.
 */
export function PricesEditor({ partner }: { partner: StaffPartner }) {
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>(linesOf(partner));
  const subs = partner.services.flatMap((s) => (s.subcategory ? [s.subcategory] : []));
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/staff/partners/{id}/prices', {
          params: { path: { id: partner.id } },
          body: {
            items: lines.map((l) => ({
              nameEn: l.nameEn.trim(),
              nameAr: l.nameAr.trim(),
              price: l.price.trim(),
              unit: l.unit,
              ...(l.subcategoryId ? { subcategoryId: l.subcategoryId } : {}),
            })),
          },
        }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: (next) => {
        setLines(linesOf(next));
        toast.show('Prices saved.');
      },
    },
  );
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const invalid = lines.some((l) => !l.nameEn.trim() || !l.nameAr.trim() || !validPrice(l.price));
  const dirty = JSON.stringify(lines) !== JSON.stringify(linesOf(partner));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader
          title="Price list"
          actions={
            <Button
              type="button"
              size="sm"
              icon={<Plus aria-hidden />}
              disabled={lines.length >= 100}
              onClick={() => setLines([...lines, { nameEn: '', nameAr: '', price: '', unit: 'fixed', subcategoryId: '' }])}
            >
              Add a line
            </Button>
          }
        />
        <CardBody>
          <div className="stack">
            {lines.length === 0 ? <span className="t-secondary">No prices announced.</span> : null}
            {lines.map((l, i) => (
              <div key={i} className="stack stack--sm">
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Input aria-label="Name in English" placeholder="Name in English" maxLength={80} value={l.nameEn} onChange={(e) => update(i, { nameEn: e.target.value })} />
                  <Input aria-label="Name in Arabic" placeholder="الاسم" dir="rtl" maxLength={80} value={l.nameAr} onChange={(e) => update(i, { nameAr: e.target.value })} />
                  <Input aria-label="Price, EGP" placeholder="EGP" inputMode="decimal" style={{ width: 120 }} value={l.price} onChange={(e) => update(i, { price: e.target.value })} />
                  <Select aria-label="Counted" value={l.unit} onChange={(e) => update(i, { unit: e.target.value as PartnerPriceUnit })}>
                    {Object.entries(PRICE_UNIT_TEXT).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Sub-category" value={l.subcategoryId} onChange={(e) => update(i, { subcategoryId: e.target.value })}>
                    <option value="">Any service</option>
                    {subs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameEn}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="text"
                    iconOnly
                    icon={<Trash2 aria-hidden />}
                    aria-label="Remove this line"
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  />
                </span>
                {l.price && !validPrice(l.price) ? <span className="field__error">EGP, two decimals at most, below a million.</span> : null}
                {fieldError(save.error, `items.${i}.subcategoryId`) ? (
                  <span className="field__error">{fieldError(save.error, `items.${i}.subcategoryId`)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
      <Alert tone="info">Residents pay the partner directly. Nothing is paid through Jiwar.</Alert>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setLines(linesOf(partner))}>
          Discard
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          Save prices
        </Button>
      </span>
    </form>
  );
}
