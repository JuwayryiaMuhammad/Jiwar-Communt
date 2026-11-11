'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, Field, ForbiddenState, Input, PageHeader, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { rateOk, thresholdOk, toggled } from '@/components/finance/tax';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/fin-tax-settings';
import en from '@/messages/en/fin-tax-settings';

type Settings = Schema<'TaxSettingsView'>;
type Kind = Settings['taxableKinds'][number];
type Category = Settings['recoverableCategories'][number];

const KINDS: Kind[] = ['service_charge', 'maintenance', 'facility', 'club', 'fine', 'damage', 'other'];
const CATEGORIES: Category[] = [
  'security',
  'cleaning',
  'landscaping',
  'maintenance',
  'utilities',
  'staff',
  'insurance',
  'administration',
  'reserve_fund',
  'other',
];

function Form({ s, canWrite }: { s: Settings; canWrite: boolean }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [registered, setRegistered] = useState(s.vatRegistered);
  const [number, setNumber] = useState(s.vatNumber ?? '');
  const [rate, setRate] = useState(s.vatRate);
  const [kinds, setKinds] = useState<Kind[]>(s.taxableKinds);
  const [recoverable, setRecoverable] = useState<Category[]>(s.recoverableCategories);
  const [withholding, setWithholding] = useState(s.withholdingEnabled);
  const [supplies, setSupplies] = useState(s.withholdingRates.supplies);
  const [services, setServices] = useState(s.withholdingRates.services);
  const [professional, setProfessional] = useState(s.withholdingRates.professional);
  const [threshold, setThreshold] = useState(s.withholdingThreshold);
  useEffect(() => {
    setRegistered(s.vatRegistered);
    setNumber(s.vatNumber ?? '');
    setRate(s.vatRate);
    setKinds(s.taxableKinds);
    setRecoverable(s.recoverableCategories);
    setWithholding(s.withholdingEnabled);
    setSupplies(s.withholdingRates.supplies);
    setServices(s.withholdingRates.services);
    setProfessional(s.withholdingRates.professional);
    setThreshold(s.withholdingThreshold);
  }, [s]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/finance/tax/settings', {
          body: {
            vatRegistered: registered,
            vatNumber: number.trim() || null,
            vatRate: rate.trim(),
            taxableKinds: kinds,
            recoverableCategories: recoverable,
            withholdingEnabled: withholding,
            suppliesRate: supplies.trim(),
            servicesRate: services.trim(),
            professionalRate: professional.trim(),
            withholdingThreshold: threshold.trim(),
          },
        }),
      ),
    { invalidate: [keys.taxAll], onDone: () => toast.show(t('saved')) },
  );
  const err = (f: string) => fieldError(save.error, f);
  const ok =
    rateOk(rate, { allowZero: false }) &&
    rateOk(supplies, { allowZero: true }) &&
    rateOk(services, { allowZero: true }) &&
    rateOk(professional, { allowZero: true }) &&
    thresholdOk(threshold) &&
    (!registered || number.trim() !== '');
  return (
    <div className="stack">
      <Card>
        <SectionHeader
          title={t('vatTitle')}
          description={
            s.vatSince ? t('vatSince', { day: f.day(s.vatSince) }) : t('vatOff')
          }
        />
        <div className="form">
          <Checkbox
            label={t('registered')}
            checked={registered}
            disabled={!canWrite}
            onChange={(e) => setRegistered(e.target.checked)}
          />
          <div className="row" style={{ gap: 16 }}>
            <Field label={t('vatNumber')} error={err('vatNumber')}>
              {(p) => <Input {...p} maxLength={40} value={number} disabled={!canWrite} onChange={(e) => setNumber(e.target.value)} />}
            </Field>
            <Field label={t('vatRate')} error={err('vatRate')} hint={t('vatRateHint')}>
              {(p) => <Input {...p} inputMode="decimal" value={rate} disabled={!canWrite} onChange={(e) => setRate(e.target.value)} />}
            </Field>
          </div>
          <fieldset className="form" disabled={!canWrite}>
            <legend className="t-secondary">
              {t('taxableKinds')}
            </legend>
            {KINDS.map((k) => (
              <Checkbox key={k} label={label(k)} checked={kinds.includes(k)} onChange={() => setKinds(toggled(kinds, KINDS, k))} />
            ))}
          </fieldset>
          <fieldset className="form" disabled={!canWrite}>
            <legend className="t-secondary">
              {t('recoverable')}
            </legend>
            {CATEGORIES.map((cat) => (
              <Checkbox
                key={cat}
                label={label(cat)}
                checked={recoverable.includes(cat)}
                onChange={() => setRecoverable(toggled(recoverable, CATEGORIES, cat))}
              />
            ))}
          </fieldset>
        </div>
      </Card>
      <Card>
        <SectionHeader
          title={t('withholdingTitle')}
          description={t('withholdingDescription')}
        />
        <div className="form">
          <Checkbox
            label={t('withholdingOn')}
            checked={withholding}
            disabled={!canWrite}
            onChange={(e) => setWithholding(e.target.checked)}
          />
          <div className="row" style={{ gap: 16 }}>
            <Field label={t('supplies')} error={err('suppliesRate')}>
              {(p) => <Input {...p} inputMode="decimal" value={supplies} disabled={!canWrite} onChange={(e) => setSupplies(e.target.value)} />}
            </Field>
            <Field label={t('services')} error={err('servicesRate')}>
              {(p) => <Input {...p} inputMode="decimal" value={services} disabled={!canWrite} onChange={(e) => setServices(e.target.value)} />}
            </Field>
            <Field label={t('professional')} error={err('professionalRate')}>
              {(p) => (
                <Input {...p} inputMode="decimal" value={professional} disabled={!canWrite} onChange={(e) => setProfessional(e.target.value)} />
              )}
            </Field>
            <Field label={t('threshold')} error={err('withholdingThreshold')} hint={t('thresholdHint')}>
              {(p) => <Input {...p} inputMode="decimal" value={threshold} disabled={!canWrite} onChange={(e) => setThreshold(e.target.value)} />}
            </Field>
          </div>
        </div>
      </Card>
      <ErrorAlert error={save.error} />
      {canWrite ? (
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" loading={save.isPending} disabled={!ok} onClick={() => save.mutate(undefined)}>
            {c('save')}
          </Button>
        </div>
      ) : (
        <Badge tone="beige">{t('needsWrite')}</Badge>
      )}
    </div>
  );
}

/**
 * Tax settings (ADR 0093): VAT registered or not, its number and rate, the
 * invoice kinds that carry it and the purchase categories whose input VAT
 * is recovered; withholding on vendors’ payouts, its rates by category and
 * the invoice size under which nothing is withheld. A change applies from
 * the next event: nothing is reposted.
 */
export default function TaxSettingsPage() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const q = useQuery({ queryKey: keys.taxSettings, queryFn: fetchers.taxSettings, enabled: allowed });
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
          <span className="row" style={{ gap: 12 }}>
            <Link href="/finance/tax/vat">{t('vatLink')}</Link>
            <Link href="/finance/tax/withholding">{t('withholdingLink')}</Link>
            <Link href="/finance/budgets">{t('fiscalYearLink')}</Link>
          </span>
        }
      />
      <QueryState query={q} rows={6}>
        {q.data ? <Form s={q.data} canWrite={can('finance.ledger_write')} /> : null}
      </QueryState>
    </>
  );
}
