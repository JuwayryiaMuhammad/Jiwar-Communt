import { ValidateBy, type ValidationOptions } from 'class-validator';
import { normalizePhone } from '../../auth/identifier';

/**
 * A phone number the services accept: local Egyptian, or international with
 * `+` (any country). The same rule as normalizePhone, so the API and the
 * services never disagree. Maps to the INVALID_PHONE field code.
 *
 * Not class-validator's `@IsPhoneNumber('EG')`: with a region it also
 * requires the number to BE from that region, which refused every foreign
 * resident's phone.
 */
export function IsPhone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      // Same constraint name: the existing mapping gives INVALID_PHONE.
      name: 'isPhoneNumber',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && normalizePhone(value) !== null,
        defaultMessage: () => 'phone must be a valid phone number',
      },
    },
    options,
  );
}
