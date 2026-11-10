'use client';

import { fieldError, humanize, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { rateOk, thresholdOk, toggled } from '@/components/finance/tax';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

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
    { invalidate: [keys.taxAll], onDone: () => toast.show('Saved. It applies from the next event.') },
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
          title="Value added tax"
          description={
            s.vatSince
              ? `Registered since ${s.vatSince}: invoices of the taxable kinds carry VAT from then; nothing before it was reposted.`
              : 'Off. Turn it on and VAT starts that day: nothing before it is reposted.'
          }
        />
        <div className="form">
          <Checkbox
            label="The compound is registered for VAT"
            checked={registered}
            disabled={!canWrite}
            onChange={(e) => setRegistered(e.target.checked)}
          />
          <div className="row" style={{ gap: 16 }}>
            <Field label="Registration number" error={err('vatNumber')}>
              {(p) => <Input {...p} maxLength={40} value={number} disabled={!canWrite} onChange={(e) => setNumber(e.target.value)} />}
            </Field>
            <Field label="Rate, %" error={err('vatRate')} hint="Egypt’s standard rate is 14.">
              {(p) => <Input {...p} inputMode="decimal" value={rate} disabled={!canWrite} onChange={(e) => setRate(e.target.value)} />}
            </Field>
          </div>
          <fieldset className="form" disabled={!canWrite}>
            <legend className="t-secondary">
              Invoice kinds that carry VAT. None by default: residential service charges are often outside VAT, and the compound decides.
            </legend>
            {KINDS.map((k) => (
              <Checkbox key={k} label={humanize(k)} checked={kinds.includes(k)} onChange={() => setKinds(toggled(kinds, KINDS, k))} />
            ))}
          </fieldset>
          <fieldset className="form" disabled={!canWrite}>
            <legend className="t-secondary">
              Purchase categories whose input VAT is recovered while registered (the VAT a vendor charges). Otherwise it stays part of the cost.
            </legend>
            {CATEGORIES.map((c) => (
              <Checkbox
                key={c}
                label={humanize(c)}
                checked={recoverable.includes(c)}
                onChange={() => setRecoverable(toggled(recoverable, CATEGORIES, c))}
              />
            ))}
          </fieldset>
        </div>
      </Card>
      <Card>
        <SectionHeader
          title="Withholding tax on vendors’ payouts"
          description="Deducted from what a vendor is paid, posted to withholding payable, with a certificate for the vendor. Each vendor, or each invoice, carries its category."
        />
        <div className="form">
          <Checkbox
            label="Withhold tax from vendors’ payouts"
            checked={withholding}
            disabled={!canWrite}
            onChange={(e) => setWithholding(e.target.checked)}
          />
          <div className="row" style={{ gap: 16 }}>
            <Field label="Supplies, %" error={err('suppliesRate')}>
              {(p) => <Input {...p} inputMode="decimal" value={supplies} disabled={!canWrite} onChange={(e) => setSupplies(e.target.value)} />}
            </Field>
            <Field label="Services and contracting, %" error={err('servicesRate')}>
              {(p) => <Input {...p} inputMode="decimal" value={services} disabled={!canWrite} onChange={(e) => setServices(e.target.value)} />}
            </Field>
            <Field label="Professional fees, %" error={err('professionalRate')}>
              {(p) => (
                <Input {...p} inputMode="decimal" value={professional} disabled={!canWrite} onChange={(e) => setProfessional(e.target.value)} />
              )}
            </Field>
            <Field label="Below this invoice subtotal, EGP" error={err('withholdingThreshold')} hint="Nothing is withheld under it.">
              {(p) => <Input {...p} inputMode="decimal" value={threshold} disabled={!canWrite} onChange={(e) => setThreshold(e.target.value)} />}
            </Field>
          </div>
        </div>
      </Card>
      <ErrorAlert error={save.error} />
      {canWrite ? (
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" loading={save.isPending} disabled={!ok} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </div>
      ) : (
        <Badge tone="beige">Changing the settings needs the ledger’s write permission.</Badge>
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
  const { ready, can } = usePermissions();
  const allowed = can('finance.ledger');
  const q = useQuery({ queryKey: keys.taxSettings, queryFn: fetchers.taxSettings, enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Tax settings" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Tax settings"
        description="The rates and rules are the compound’s to set; the defaults are common Egyptian practice, not advice."
        actions={
          <span className="row" style={{ gap: 12 }}>
            <Link href="/finance/tax/vat">VAT declaration</Link>
            <Link href="/finance/tax/withholding">Withholding</Link>
            <Link href="/finance/budgets">Fiscal year’s first month</Link>
          </span>
        }
      />
      <QueryState query={q} rows={6}>
        {q.data ? <Form s={q.data} canWrite={can('finance.ledger_write')} /> : null}
      </QueryState>
    </>
  );
}
