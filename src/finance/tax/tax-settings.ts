import { Prisma, type FinanceSettings, type InvoiceKind } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { vatOf, type WithholdingCategory } from './tax-rules';

type Money = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

/**
 * The compound's tax settings (ADR 0093), read in the caller's tenant
 * transaction: one row a compound (finance's provisioning writes it; a
 * compound written by hand in a test reads the defaults).
 */
export async function taxSettingsIn(
  tx: TenantTxClient,
): Promise<FinanceSettings | null> {
  return tx.financeSettings.findFirst();
}

/** The VAT rate an invoice of a kind carries now: null when untaxed. */
export function vatRateOf(
  s: FinanceSettings | null,
  kind: InvoiceKind,
): Money | null {
  if (!s?.vatRegistered || !s.vatTaxableKinds.includes(kind)) return null;
  return new Prisma.Decimal(s.vatRate);
}

export interface InvoiceLineInput {
  descriptionEn: string;
  descriptionAr: string;
  /** Net of VAT. */
  amount: Money;
  /** Given: the line's VAT as it is (an instalment's share); else computed. */
  vat?: Money;
}

/**
 * An invoice's lines with their VAT (ADR 0093): while the compound is
 * registered and the kind taxable, each line's at the rate; lines that say
 * their own VAT keep it (an instalment plan's share of the invoice it
 * replaces), at the rate they name. The total is net and VAT.
 */
export async function withVat(
  tx: TenantTxClient,
  kind: InvoiceKind,
  lines: readonly InvoiceLineInput[],
  given?: { rate: Money },
): Promise<{
  lines: (InvoiceLineInput & { vat: Money })[];
  rate: Money;
  vat: Money;
  total: Money;
}> {
  const explicit = lines.some((l) => l.vat !== undefined);
  const rate = explicit
    ? (given?.rate ?? ZERO)
    : (vatRateOf(await taxSettingsIn(tx), kind) ?? ZERO);
  const out = lines.map((l) => ({
    ...l,
    vat: explicit
      ? (l.vat ?? ZERO)
      : rate.gt(ZERO)
        ? vatOf(l.amount, rate)
        : ZERO,
  }));
  const vat = out.reduce((s, l) => s.add(l.vat), ZERO);
  const total = out.reduce((s, l) => s.add(l.amount).add(l.vat), ZERO);
  return {
    lines: out,
    rate: vat.gt(ZERO) || !explicit ? rate : ZERO,
    vat,
    total,
  };
}

/** The withholding rates of the settings, by category. */
export function withholdingRates(
  s: FinanceSettings,
): Record<Exclude<WithholdingCategory, 'exempt'>, Money> {
  return {
    supplies: new Prisma.Decimal(s.withholdingSuppliesRate),
    services: new Prisma.Decimal(s.withholdingServicesRate),
    professional: new Prisma.Decimal(s.withholdingProfessionalRate),
  };
}
