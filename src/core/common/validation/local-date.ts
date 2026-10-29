import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * A calendar day as the API takes one, `YYYY-MM-DD`. The pattern alone lets
 * 2026-02-30 through: `new Date('2026-02-30T00:00:00Z')` rolls over to
 * 2 March, and `'2026-02-30'::date` is a database error, not a field error.
 */
export const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Whether `YYYY-MM-DD` names a real day (no 31 April, no 29 February 2026). */
export function isRealDate(value: unknown): boolean {
  if (typeof value !== 'string' || !LOCAL_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === value;
}

/**
 * A string field holding a day that exists. Maps to INVALID_FORMAT, as
 * `@Matches` did, so a day that is not one fails where its shape would.
 */
export function IsLocalDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      // Same constraint name: the existing mapping gives INVALID_FORMAT.
      name: 'matches',
      validator: {
        validate: isRealDate,
        defaultMessage: (args) =>
          `${args?.property ?? 'value'} must be a day that exists, YYYY-MM-DD`,
      },
    },
    options,
  );
}
