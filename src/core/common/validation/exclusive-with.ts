import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Of two fields, at most one: this one is refused when `other` is sent too.
 * Maps to FIELD_NOT_ALLOWED. Pair with `@ValidateIf` on `other` for
 * "exactly one" (`other` is then the field reported as missing).
 */
export function ExclusiveWith(
  other: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'exclusiveWith',
      constraints: [other],
      validator: {
        validate: (_: unknown, args) =>
          (args?.object as Record<string, unknown>)[other] === undefined,
        defaultMessage: (args) =>
          `send either ${String(args?.constraints[0])} or ${String(args?.property)}, not both`,
      },
    },
    options,
  );
}
