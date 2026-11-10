'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardBody, CardHeader, Input, Select, useToast } from '@jiwar/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type PartnerPriceUnit, type StaffPartner } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-edit';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-edit';
import { PRICE_UNITS, validPrice, word } from './logic';

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
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const { locale } = useLocale();
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
        toast.show(t('prices.saved'));
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
          title={t('prices.title')}
          actions={
            <Button
              type="button"
              size="sm"
              icon={<Plus aria-hidden />}
              disabled={lines.length >= 100}
              onClick={() => setLines([...lines, { nameEn: '', nameAr: '', price: '', unit: 'fixed', subcategoryId: '' }])}
            >
              {t('prices.addLine')}
            </Button>
          }
        />
        <CardBody>
          <div className="stack">
            {lines.length === 0 ? <span className="t-secondary">{t('prices.none')}</span> : null}
            {lines.map((l, i) => (
              <div key={i} className="stack stack--sm">
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Input aria-label={t('nameEn')} placeholder={t('prices.namePlaceholder')} maxLength={80} value={l.nameEn} onChange={(e) => update(i, { nameEn: e.target.value })} />
                  <Input aria-label={t('nameAr')} placeholder={t('prices.nameArPlaceholder')} dir="rtl" maxLength={80} value={l.nameAr} onChange={(e) => update(i, { nameAr: e.target.value })} />
                  <Input aria-label={t('prices.priceLabel')} placeholder={t('prices.pricePlaceholder')} className="ltr" inputMode="decimal" style={{ width: 120 }} value={l.price} onChange={(e) => update(i, { price: e.target.value })} />
                  <Select aria-label={t('prices.counted')} value={l.unit} onChange={(e) => update(i, { unit: e.target.value as PartnerPriceUnit })}>
                    {PRICE_UNITS.map((value) => (
                      <option key={value} value={value}>
                        {word(codes, 'unit', value)}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label={t('prices.subcategory')} value={l.subcategoryId} onChange={(e) => update(i, { subcategoryId: e.target.value })}>
                    <option value="">{t('prices.anyService')}</option>
                    {subs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {locale === 'ar' ? s.nameAr : s.nameEn}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="text"
                    iconOnly
                    icon={<Trash2 aria-hidden />}
                    aria-label={t('prices.removeLine')}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  />
                </span>
                {l.price && !validPrice(l.price) ? <span className="field__error">{t('prices.invalid')}</span> : null}
                {fieldError(save.error, `items.${i}.subcategoryId`) ? (
                  <span className="field__error">{fieldError(save.error, `items.${i}.subcategoryId`)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
      <Alert tone="info">{t('prices.direct')}</Alert>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setLines(linesOf(partner))}>
          {t('discard')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || invalid}>
          {t('prices.save')}
        </Button>
      </span>
    </form>
  );
}
