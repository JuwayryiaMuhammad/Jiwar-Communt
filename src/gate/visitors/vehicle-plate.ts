/**
 * A visitor's vehicle plate (ADR 0043), as Egyptian plates are written and
 * as foreign ones are: Arabic letters, Latin letters, Western or
 * Arabic-Indic digits, and spaces. Stored as typed, tidied: trimmed, runs of
 * spaces made one, Latin letters upper case. 1–12 characters after that.
 */
export const PLATE_MAX = 12;
const PLATE = /^[A-Z0-9ء-غف-ي٠-٩ ]+$/;

/** The plate to store, or null when it is not one. */
export function normalizePlate(raw: string): string | null {
  const plate = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!plate || plate.length > PLATE_MAX || !PLATE.test(plate)) return null;
  return plate;
}
