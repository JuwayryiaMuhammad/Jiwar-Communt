import { HttpException, HttpStatus } from '@nestjs/common';

// ============================================================================
// Error contract (ADR 0013)
// ============================================================================
//
// The API never returns display text. Every error carries a stable `code`
// (and optional `params` / `fields`) that the frontend translates; `message`
// is English for developers only. Services and guards throw AppException —
// a unit test fails the build on any other `new *Exception(` in src/.

/** Top-level error codes. Clients branch on these, never on `message`. */
export const ErrorCode = {
  // generic
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  RELATED_RESOURCE_MISSING: 'RELATED_RESOURCE_MISSING',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  NOT_READY: 'NOT_READY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  REQUEST_FAILED: 'REQUEST_FAILED',
  // auth
  OTP_INVALID: 'OTP_INVALID',
  LOGIN_TICKET_INVALID: 'LOGIN_TICKET_INVALID',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  // resources
  UNIT_NOT_FOUND: 'UNIT_NOT_FOUND',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  CANNOT_CHANGE_OWN_STATUS: 'CANNOT_CHANGE_OWN_STATUS',
  // frozen accounts (ADR 0023)
  ACCOUNT_FROZEN: 'ACCOUNT_FROZEN',
  ACCOUNT_NOT_FROZEN: 'ACCOUNT_NOT_FROZEN',
  ACCOUNT_PHONE_MUST_CHANGE: 'ACCOUNT_PHONE_MUST_CHANGE',
  PHONE_RELEASED: 'PHONE_RELEASED',
  // account deletion (ADR 0023)
  CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',
  DELETION_ALREADY_REQUESTED: 'DELETION_ALREADY_REQUESTED',
  DELETION_REQUEST_NOT_FOUND: 'DELETION_REQUEST_NOT_FOUND',
  DELETION_GRACE_OVER: 'DELETION_GRACE_OVER',
  DELETION_GRACE_NOT_OVER: 'DELETION_GRACE_NOT_OVER',
  LEGAL_HOLD_ACTIVE: 'LEGAL_HOLD_ACTIVE',
  LEGAL_HOLD_NOT_FOUND: 'LEGAL_HOLD_NOT_FOUND',
  SCOPE_CONFIRMATION_MISMATCH: 'SCOPE_CONFIRMATION_MISMATCH',
  OCCUPANCY_NOT_FOUND: 'OCCUPANCY_NOT_FOUND',
  OCCUPANCY_ALREADY_ACTIVE: 'OCCUPANCY_ALREADY_ACTIVE',
  // capacities (ADR 0020)
  PRIMARY_MUST_RESIDE: 'PRIMARY_MUST_RESIDE',
  OCCUPANCY_NOT_CONVERTIBLE: 'OCCUPANCY_NOT_CONVERTIBLE',
  // unit states (ADR 0021)
  HOUSEHOLD_UNDER_REVIEW: 'HOUSEHOLD_UNDER_REVIEW',
  SEPARATION_MANAGER_DECISION: 'SEPARATION_MANAGER_DECISION',
  REVIEW_FLAG_NOT_FOUND: 'REVIEW_FLAG_NOT_FOUND',
  /** A primary_left flag is resolved by setPrimary or endHousehold only. */
  REVIEW_NEEDS_DECISION: 'REVIEW_NEEDS_DECISION',
  // self-registration (ADR 0024)
  REGISTRATION_NOT_FOUND: 'REGISTRATION_NOT_FOUND',
  REGISTRATION_LINK_NOT_FOUND: 'REGISTRATION_LINK_NOT_FOUND',
  REGISTRATION_CONFLICT: 'REGISTRATION_CONFLICT',
  UNIT_DETAIL_ALREADY_SET: 'UNIT_DETAIL_ALREADY_SET',
  // member permissions (ADR 0021)
  MEMBER_PERMISSION_MISSING: 'MEMBER_PERMISSION_MISSING',
  FINANCE_CAP_EXCEEDED: 'FINANCE_CAP_EXCEEDED',
  MEMBER_HAS_NO_ACCOUNT: 'MEMBER_HAS_NO_ACCOUNT',
  DEFERRED_ACTION_NOT_FOUND: 'DEFERRED_ACTION_NOT_FOUND',
  MEMBER_NOT_YET_ADULT: 'MEMBER_NOT_YET_ADULT',
  MAJORITY_INVITE_PENDING: 'MAJORITY_INVITE_PENDING',
  // access (ADR 0010)
  NO_ROLE_FOR_ACCOUNT_TYPE: 'NO_ROLE_FOR_ACCOUNT_TYPE',
  ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
  UNKNOWN_PERMISSION: 'UNKNOWN_PERMISSION',
  PERMISSION_NOT_ASSIGNABLE: 'PERMISSION_NOT_ASSIGNABLE',
  ROLE_LOCKOUT: 'ROLE_LOCKOUT',
  // platform (ADR 0011)
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  // household (ADR 0016)
  NOT_PRIMARY_RESIDENT: 'NOT_PRIMARY_RESIDENT',
  INVITE_MINOR_NOT_ALLOWED: 'INVITE_MINOR_NOT_ALLOWED',
  MEMBER_NOT_MINOR: 'MEMBER_NOT_MINOR',
  HOUSEHOLD_LIMIT_REACHED: 'HOUSEHOLD_LIMIT_REACHED',
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  HOUSEHOLD_MEMBER_NOT_FOUND: 'HOUSEHOLD_MEMBER_NOT_FOUND',
  REASON_REQUIRED: 'REASON_REQUIRED',
  DELEGATION_NOT_ALLOWED: 'DELEGATION_NOT_ALLOWED',
  DELEGATE_NOT_ELIGIBLE: 'DELEGATE_NOT_ELIGIBLE',
  DELEGATION_EXPIRED: 'DELEGATION_EXPIRED',
  DELEGATION_NOT_FOUND: 'DELEGATION_NOT_FOUND',
  // domestic workers (ADR 0017)
  WORKER_UNDERAGE: 'WORKER_UNDERAGE',
  WORKER_BLOCKED_BY_MANAGEMENT: 'WORKER_BLOCKED_BY_MANAGEMENT',
  /** A warning in a successful result, never an error response. */
  WORKER_SCHEDULE_CONFLICT: 'WORKER_SCHEDULE_CONFLICT',
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  ENGAGEMENT_NOT_FOUND: 'ENGAGEMENT_NOT_FOUND',
  /** A passport worker's birth date needs a manager's attestation (ADR 0018). */
  BIRTH_DATE_CONFIRMATION_REQUIRED: 'BIRTH_DATE_CONFIRMATION_REQUIRED',
  // compliance and card incidents (ADR 0022)
  WORKER_COMPLIANCE_HOLD: 'WORKER_COMPLIANCE_HOLD',
  COMPLIANCE_CASE_NOT_FOUND: 'COMPLIANCE_CASE_NOT_FOUND',
  CARD_INCIDENT_NOT_FOUND: 'CARD_INCIDENT_NOT_FOUND',
  // notifications (ADR 0027)
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  // idempotent writes (ADR 0028)
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  // the gate (ADR 0028)
  GATE_NOT_FOUND: 'GATE_NOT_FOUND',
  /** A gate action needs the caller's open shift (a 403, ADR 0025). */
  NO_OPEN_SHIFT: 'NO_OPEN_SHIFT',
  SHIFT_ALREADY_OPEN: 'SHIFT_ALREADY_OPEN',
  VISITOR_PASS_NOT_FOUND: 'VISITOR_PASS_NOT_FOUND',
  VISITOR_PASS_LIMIT_REACHED: 'VISITOR_PASS_LIMIT_REACHED',
  VISITOR_PASS_NOT_ACTIVE: 'VISITOR_PASS_NOT_ACTIVE',
  GATE_SUBJECT_NOT_FOUND: 'GATE_SUBJECT_NOT_FOUND',
  /** An entry the subject's pass or engagement does not allow (params.reason). */
  GATE_ENTRY_REFUSED: 'GATE_ENTRY_REFUSED',
  ALREADY_INSIDE: 'ALREADY_INSIDE',
  NOT_INSIDE: 'NOT_INSIDE',
  GATE_REQUEST_NOT_FOUND: 'GATE_REQUEST_NOT_FOUND',
  /** Someone answered first, or the time ran out (params.status). */
  GATE_REQUEST_DECIDED: 'GATE_REQUEST_DECIDED',
  /** The worker may come in on their schedule: nothing to ask. */
  GATE_REQUEST_NOT_NEEDED: 'GATE_REQUEST_NOT_NEEDED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Per-field codes inside `fields` (validation and duplicate values). */
export const FieldErrorCode = {
  FIELD_REQUIRED: 'FIELD_REQUIRED',
  FIELD_NOT_ALLOWED: 'FIELD_NOT_ALLOWED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PHONE: 'INVALID_PHONE',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_NATIONAL_ID: 'INVALID_NATIONAL_ID',
  INVALID_PASSPORT_NUMBER: 'INVALID_PASSPORT_NUMBER',
  INVALID_NATIONALITY: 'INVALID_NATIONALITY',
  BIRTH_DATE_REQUIRED: 'BIRTH_DATE_REQUIRED',
  INVALID_BIRTH_DATE: 'INVALID_BIRTH_DATE',
  /** A schedule window that starts and ends at the same minute. */
  INVALID_SCHEDULE: 'INVALID_SCHEDULE',
  /** A reason code outside the action's closed list (Phase 2.2). */
  INVALID_REASON_CODE: 'INVALID_REASON_CODE',
  INVALID_UUID: 'INVALID_UUID',
  INVALID_LENGTH: 'INVALID_LENGTH',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_NUMBER: 'INVALID_NUMBER',
  INVALID_VALUE: 'INVALID_VALUE',
  DUPLICATE_VALUE: 'DUPLICATE_VALUE',
  SAME_AS_CURRENT: 'SAME_AS_CURRENT',
} as const;

export type FieldErrorCode =
  (typeof FieldErrorCode)[keyof typeof FieldErrorCode];

export type ErrorParams = Record<string, string | number | boolean | string[]>;

export interface FieldError {
  /** API field path, e.g. `email` or `units.0.unitId`. */
  field: string;
  code: FieldErrorCode;
  params?: ErrorParams;
}

export interface AppErrorBody {
  message: string;
  code: ErrorCode;
  params?: ErrorParams;
  fields?: FieldError[];
  details?: Record<string, unknown>;
}

/** The only exception type the application throws. */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    extra: Omit<AppErrorBody, 'message' | 'code'> = {},
  ) {
    super({ message, code, ...extra } satisfies AppErrorBody, status);
  }
}

type Extra = Omit<AppErrorBody, 'message' | 'code'>;

/** Shorthands, so call sites read as `throw appError.notFound(...)`. */
export const appError = {
  badRequest: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.BAD_REQUEST, code, message, extra),
  unauthorized: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.UNAUTHORIZED, code, message, extra),
  forbidden: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.FORBIDDEN, code, message, extra),
  notFound: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.NOT_FOUND, code, message, extra),
  conflict: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.CONFLICT, code, message, extra),
  tooManyRequests: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.TOO_MANY_REQUESTS, code, message, extra),
  serviceUnavailable: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.SERVICE_UNAVAILABLE, code, message, extra),
};

/**
 * A tenant-scoped query ran without a tenant in the request context. This is
 * a programming error (a route missing the auth guard, a job without
 * context), so it surfaces as a 500 — never as an empty result.
 */
export class TenantContextMissingError extends Error {
  constructor() {
    super('No tenant in the request context; refusing to run a tenant query');
    this.name = 'TenantContextMissingError';
  }
}

/**
 * The tenant client was used in a way that would escape the transaction that
 * carries the tenant setting: `$transaction`/raw SQL on PrismaService.tenant,
 * or PrismaService.tenant inside a withTenantTx callback. See ADR 0005.
 */
export class TenantClientMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantClientMisuseError';
  }
}
