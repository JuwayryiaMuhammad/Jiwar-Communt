import { ValidateBy, type ValidationOptions } from 'class-validator';
import { parseEgyptianNationalId } from '../egyptian-national-id';

/** Maps to the INVALID_NATIONAL_ID field code (validation-errors.ts). */
export function IsEgyptianNationalId(
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isEgyptianNationalId',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && parseEgyptianNationalId(value) !== null,
        defaultMessage: () => 'nationalId must be a valid Egyptian national ID',
      },
    },
    options,
  );
}
