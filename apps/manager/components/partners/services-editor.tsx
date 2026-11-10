'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Checkbox, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type PartnerCategory, type StaffPartner } from '@/lib/queries';
import arCodes from '@/messages/ar/partners-codes';
import ar from '@/messages/ar/partners-edit';
import enCodes from '@/messages/en/partners-codes';
import en from '@/messages/en/partners-edit';
import { CATEGORIES, word } from './logic';

/** `home_services` for a whole category, `home_services:<id>` for a sub-category. */
const code = (category: string, subcategoryId: string | null) => (subcategoryId ? `${category}:${subcategoryId}` : category);

export function servicesOf(partner: StaffPartner): string[] {
  return partner.services.map((s) => code(s.category, s.subcategory?.id ?? null));
}

/**
 * What a partner does (ADR 0060): a whole category, or some of its
 * sub-categories. Replaced as a whole; at least one. Requests already made
 * keep what they asked.
 */
export function ServicesEditor({ partner }: { partner: StaffPartner }) {
  const t = useT(en, ar);
  const codes = useT(enCodes, arCodes);
  const { locale } = useLocale();
  const toast = useToast();
  const subs = useQuery({ queryKey: keys.partnerSubcategories, queryFn: fetchers.partnerSubcategories });
  const [picked, setPicked] = useState<string[]>(servicesOf(partner));
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/staff/partners/{id}/services', {
          params: { path: { id: partner.id } },
          body: {
            services: picked.map((p) => {
              const [category, subcategoryId] = p.split(':');
              return { category: category as PartnerCategory, ...(subcategoryId ? { subcategoryId } : {}) };
            }),
          },
        }),
      ),
    {
      invalidate: [keys.partnersAll],
      onDone: (next) => {
        setPicked(servicesOf(next));
        toast.show(t('services.saved'));
      },
    },
  );
  const toggle = (c: string) => setPicked(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c]);
  const dirty = [...picked].sort().join('|') !== servicesOf(partner).sort().join('|');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && picked.length) save.mutate();
      }}
    >
      <Card flush>
        <CardHeader title={t('services.title')} />
        <CardBody>
          <QueryState query={subs}>
            <div className="stack">
              {CATEGORIES.map((category) => {
                const mine = (subs.data?.data ?? []).filter((s) => s.category === category && (s.active || picked.includes(code(category, s.id))));
                return (
                  <div key={category} className="stack stack--sm">
                    <Checkbox
                      label={t('services.wholeCategory', { category: word(codes, 'category', category) })}
                      checked={picked.includes(category)}
                      onChange={() => toggle(category)}
                    />
                    <div className="row" style={{ flexWrap: 'wrap', gap: 16, paddingInlineStart: 24 }}>
                      {mine.map((s) => (
                        <Checkbox
                          key={s.id}
                          label={s.active ? (locale === 'ar' ? s.nameAr : s.nameEn) : t('services.retired', { name: locale === 'ar' ? s.nameAr : s.nameEn })}
                          checked={picked.includes(code(category, s.id))}
                          onChange={() => toggle(code(category, s.id))}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </QueryState>
        </CardBody>
      </Card>
      <ErrorAlert error={save.error} />
      <span className="row">
        <span className="spacer" />
        <Button type="button" disabled={!dirty} onClick={() => setPicked(servicesOf(partner))}>
          {t('discard')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || picked.length === 0}>
          {t('services.save')}
        </Button>
      </span>
    </form>
  );
}
