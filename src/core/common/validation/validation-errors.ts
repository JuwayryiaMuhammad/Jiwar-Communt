import { ValidationError, type ValidationOptions } from 'class-validator';
import {
  appError,
  AppException,
  ErrorCode,
  FieldErrorCode,
  type ErrorParams,
  type FieldError,
} from '../errors';

/** class-validator constraint name → field code. */
const CONSTRAINT_CODES: Record<string, FieldErrorCode> = {
  whitelistValidation: FieldErrorCode.FIELD_NOT_ALLOWED,
  isNotEmpty: FieldErrorCode.FIELD_REQUIRED,
  isDefined: FieldErrorCode.FIELD_REQUIRED,
  isString: FieldErrorCode.INVALID_TYPE,
  isArray: FieldErrorCode.INVALID_TYPE,
  isObject: FieldErrorCode.INVALID_TYPE,
  isPhoneNumber: FieldErrorCode.INVALID_PHONE,
  isEmail: FieldErrorCode.INVALID_EMAIL,
  isEgyptianNationalId: FieldErrorCode.INVALID_NATIONAL_ID,
  isUuid: FieldErrorCode.INVALID_UUID,
  isLength: FieldErrorCode.INVALID_LENGTH,
  arrayMinSize: FieldErrorCode.INVALID_LENGTH,
  arrayMaxSize: FieldErrorCode.INVALID_LENGTH,
  matches: FieldErrorCode.INVALID_FORMAT,
  isInt: FieldErrorCode.INVALID_NUMBER,
  isNumber: FieldErrorCode.INVALID_NUMBER,
  min: FieldErrorCode.INVALID_NUMBER,
  max: FieldErrorCode.INVALID_NUMBER,
  isEnum: FieldErrorCode.INVALID_VALUE,
  isIn: FieldErrorCode.INVALID_VALUE,
};

/** When a field fails several constraints, report the most fundamental one. */
const PRIORITY: FieldErrorCode[] = [
  FieldErrorCode.FIELD_NOT_ALLOWED,
  FieldErrorCode.FIELD_REQUIRED,
  FieldErrorCode.INVALID_TYPE,
];

/**
 * Attach translation params to a decorator: `@Length(2, 200, withParams({ min: 2, max: 200 }))`.
 * They surface as `fields[].params` for the frontend's message template.
 */
export function withParams(
  params: ErrorParams,
  options: ValidationOptions = {},
): ValidationOptions {
  return { ...options, context: { params } };
}

/** One `{field, code, params?}` per failing field, nested paths flattened. */
export function toFieldErrors(
  errors: ValidationError[],
  path = '',
): FieldError[] {
  return errors.flatMap((err) => {
    const field = path ? `${path}.${err.property}` : err.property;
    const own = fieldError(err, field);
    return [...(own ? [own] : []), ...toFieldErrors(err.children ?? [], field)];
  });
}

function fieldError(err: ValidationError, field: string): FieldError | null {
  const constraints = Object.keys(err.constraints ?? {});
  if (constraints.length === 0) return null;

  // A missing value fails every decorator on the field; that is one fact.
  if (
    (err.value === undefined || err.value === null) &&
    !constraints.includes('whitelistValidation')
  ) {
    return { field, code: FieldErrorCode.FIELD_REQUIRED };
  }

  const mapped = constraints.map((name) => ({
    name,
    code: CONSTRAINT_CODES[name] ?? FieldErrorCode.INVALID_VALUE,
  }));
  const chosen =
    PRIORITY.map((p) => mapped.find((m) => m.code === p)).find(Boolean) ??
    mapped[0];
  const params = (
    err.contexts?.[chosen.name] as { params?: ErrorParams } | undefined
  )?.params;
  return params
    ? { field, code: chosen.code, params }
    : { field, code: chosen.code };
}

/** ValidationPipe `exceptionFactory`. `message` stays English for developers. */
export function validationException(errors: ValidationError[]): AppException {
  const fields = toFieldErrors(errors);
  const message = flattenMessages(errors).join(', ') || 'Validation failed';
  return appError.badRequest(ErrorCode.VALIDATION_FAILED, message, { fields });
}

function flattenMessages(errs: ValidationError[], path = ''): string[] {
  return errs.flatMap((err) => {
    const here = path ? `${path}.${err.property}` : err.property;
    const own = Object.values(err.constraints ?? {}).map((m) =>
      path ? `${here}: ${m}` : m,
    );
    return [...own, ...flattenMessages(err.children ?? [], here)];
  });
}
