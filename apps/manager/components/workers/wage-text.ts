import type { Format } from '@jiwar/i18n/core';

/**
 * A wage as the finance pages show money: "3200.00" → "3,200.00 EGP", in the
 * currency the API names (the compound's, ISO 4217; EGP when it names none).
 */
export function wageText(f: Format, amount: string | null | undefined, currency?: string | null): string {
  return amount === null || amount === undefined ? '—' : f.money(amount, currency);
}
