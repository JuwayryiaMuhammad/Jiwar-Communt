import { Transform } from 'class-transformer';
import { ValidateBy, type ValidationOptions } from 'class-validator';
import { isRealDate } from './local-date';

/**
 * An instant as the API takes one (RFC 3339 `date-time`): a date, a time
 * and an offset, `Z` or `±HH:MM`. Without the offset a time names no
 * instant: `new Date('2026-10-22T22:00')` reads it in the server's own
 * zone (UTC in the containers), so a Cairo client's 22:00 would be kept as
 * 01:00 the next day.
 *
 * The shape is not enough either: `Date.parse` rolls 2099-02-30T08:00Z over
 * to 2 March and T24:00 to the next day. So the day must exist (as
 * isRealDate has it), the time be 00:00:00 to 23:59:59, and the offset's
 * hours and minutes be RFC 3339's (under 24 and 60).
 */
export const INSTANT =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

/** Two digits the shape matched, or 0 when the part is absent. */
const part = (digits: string | undefined) => Number(digits ?? 0);

const isInstant = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const m = INSTANT.exec(value);
  if (!m || !isRealDate(m[1])) return false;
  const [hh, mm, ss, offH, offM] = [m[2], m[3], m[4], m[5], m[6]].map(part);
  return (
    hh < 24 &&
    mm < 60 &&
    ss < 60 &&
    offH < 24 &&
    offM < 60 &&
    !Number.isNaN(Date.parse(value))
  );
};

/**
 * The instant a value names, or null: for what a DTO does not read (a
 * signed payload, an offline action).
 */
export const instantOf = (value: unknown): Date | null =>
  isInstant(value) ? new Date(value) : null;

/**
 * A `Date` field read from an instant (with `@IsDate()`). Anything else is
 * left as it came, for `@IsDate()` to refuse: INVALID_FORMAT.
 */
export function ToInstant(): PropertyDecorator {
  return Transform(
    ({ value }: { value: unknown }) => instantOf(value) ?? value,
  );
}

/** A string field holding an instant. Maps to INVALID_FORMAT. */
export function IsInstant(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      // Same constraint name: the existing mapping gives INVALID_FORMAT.
      name: 'isIso8601',
      validator: {
        validate: isInstant,
        defaultMessage: (args) =>
          `${args?.property ?? 'value'} must be a date-time with an offset (Z or ±HH:MM)`,
      },
    },
    options,
  );
}
