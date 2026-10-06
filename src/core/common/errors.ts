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
  // the resident's entry QR (ADR 0031)
  /** No unit where the caller lives (a landlord, a pending member, a guard…). */
  NOT_A_RESIDENT: 'NOT_A_RESIDENT',
  ENTRY_CREDENTIAL_LIMIT_REACHED: 'ENTRY_CREDENTIAL_LIMIT_REACHED',
  ENTRY_CREDENTIAL_NOT_FOUND: 'ENTRY_CREDENTIAL_NOT_FOUND',
  /** Someone answered first, or the time ran out (params.status). */
  GATE_REQUEST_DECIDED: 'GATE_REQUEST_DECIDED',
  /** The worker may come in on their schedule: nothing to ask. */
  GATE_REQUEST_NOT_NEEDED: 'GATE_REQUEST_NOT_NEEDED',
  // parcels (ADR 0035)
  /** Unknown, another compound's, or not the caller's to see: one answer. */
  PARCEL_NOT_FOUND: 'PARCEL_NOT_FOUND',
  /** An unknown, dead or foreign code or QR: one answer, whatever was wrong. */
  PARCEL_CODE_INVALID: 'PARCEL_CODE_INVALID',
  /** A genuine resident QR whose time has passed (ADR 0031's expired_qr). */
  PARCEL_QR_EXPIRED: 'PARCEL_QR_EXPIRED',
  /** The parcel is not in a status that allows this (params.status). */
  PARCEL_STATE_CONFLICT: 'PARCEL_STATE_CONFLICT',
  PARCEL_DELEGATE_EXISTS: 'PARCEL_DELEGATE_EXISTS',
  /** An unclaimed parcel may be returned only after the manager days. */
  PARCEL_NOT_YET_RETURNABLE: 'PARCEL_NOT_YET_RETURNABLE',
  // files (ADR 0029)
  /** The object store failed or is unreachable (503). */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** Finalize before the PUT completed (409). */
  FILE_UPLOAD_MISSING: 'FILE_UPLOAD_MISSING',
  /** Finalize long after the upload URL expired (409): start again. */
  FILE_UPLOAD_EXPIRED: 'FILE_UPLOAD_EXPIRED',
  /** The bytes are not the declared size or type (422); the file is gone. */
  FILE_CONTENT_MISMATCH: 'FILE_CONTENT_MISMATCH',
  /** Too many unfinalized uploads (429); params.limit. */
  FILE_PENDING_LIMIT: 'FILE_PENDING_LIMIT',
  // maintenance (ADR 0032)
  /** Unknown, another compound's, or one the caller may not see. */
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  TICKET_CATEGORY_NOT_FOUND: 'TICKET_CATEGORY_NOT_FOUND',
  /** Unknown, or another compound's (ADR 0033). */
  SPECIALTY_NOT_FOUND: 'SPECIALTY_NOT_FOUND',
  /** Not an active staff account holding tickets.work. */
  TECHNICIAN_NOT_FOUND: 'TECHNICIAN_NOT_FOUND',
  /** The dispatch lock stayed held too long (503): try again (ADR 0033). */
  DISPATCH_BUSY: 'DISPATCH_BUSY',
  /** The ticket's status does not allow the action (409, params.status). */
  TICKET_INVALID_TRANSITION: 'TICKET_INVALID_TRANSITION',
  /** No `tickets` capability on the unit, or on any unit (403). */
  TICKETS_NOT_ALLOWED: 'TICKETS_NOT_ALLOWED',
  /** The caller sees the ticket but is not its reporter or creator (403). */
  TICKET_ACTION_NOT_ALLOWED: 'TICKET_ACTION_NOT_ALLOWED',
  /** params.max photos of this kind already (409). */
  TICKET_PHOTO_LIMIT_REACHED: 'TICKET_PHOTO_LIMIT_REACHED',
  /** Closed longer ago than the compound's reopen window (409). */
  TICKET_REOPEN_WINDOW_PASSED: 'TICKET_REOPEN_WINDOW_PASSED',
  // visits (ADR 0034)
  /** Unknown, another ticket's, or not the caller's to see. */
  VISIT_NOT_FOUND: 'VISIT_NOT_FOUND',
  /** The ticket already has a proposed, confirmed or arrived visit (409). */
  VISIT_ALREADY_ACTIVE: 'VISIT_ALREADY_ACTIVE',
  /** The visit's status does not allow the action (409, params.status). */
  VISIT_INVALID_TRANSITION: 'VISIT_INVALID_TRANSITION',
  /** Arrival outside [start − 30 min, end + 2 h] (409). */
  VISIT_OUTSIDE_ARRIVAL_WINDOW: 'VISIT_OUTSIDE_ARRIVAL_WINDOW',
  /** A common-area ticket has no visits (409). */
  VISIT_NOT_FOR_COMMON_AREA: 'VISIT_NOT_FOR_COMMON_AREA',
  /** The other side confirms a proposal, never its own side (403). */
  VISIT_SAME_SIDE: 'VISIT_SAME_SIDE',
  /** No `visitConsent` on the unit (403). */
  VISITS_NOT_ALLOWED: 'VISITS_NOT_ALLOWED',
  /**
   * Only an adult who lives in the unit, with an active account, allows a
   * technician in while nobody is home (403).
   */
  VISIT_CONSENT_NOT_ALLOWED: 'VISIT_CONSENT_NOT_ALLOWED',
  // preferences, consents, export, deletion (ADR 0036)
  /** A grant must answer the consent's current version (409, params.current). */
  CONSENT_VERSION_MISMATCH: 'CONSENT_VERSION_MISMATCH',
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
  // files (ADR 0029)
  /** The purpose does not take this type; params.allowed lists those it does. */
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  /** params.maxBytes is the purpose's limit. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** Not one of the caller's finalized files of the right purpose. */
  FILE_NOT_AVAILABLE: 'FILE_NOT_AVAILABLE',
  // maintenance (ADR 0032)
  /** The category may not be used for a common area. */
  CATEGORY_NOT_FOR_COMMON_AREA: 'CATEGORY_NOT_FOR_COMMON_AREA',
  /** Not an active specialty of this compound (ADR 0033). */
  SPECIALTY_NOT_AVAILABLE: 'SPECIALTY_NOT_AVAILABLE',
  /** Unknown, or holds no `tickets` capability where the ticket is. */
  REPORTER_NOT_ELIGIBLE: 'REPORTER_NOT_ELIGIBLE',
  // visits and the SLA (ADR 0034)
  /** A response target longer than the resolution target of its priority. */
  SLA_RESPONSE_AFTER_RESOLUTION: 'SLA_RESPONSE_AFTER_RESOLUTION',
  /** A visit must start at least 15 minutes from now. */
  VISIT_TOO_SOON: 'VISIT_TOO_SOON',
  /** A visit must start within 30 days. */
  VISIT_TOO_FAR: 'VISIT_TOO_FAR',
  /** A visit lasts at most four hours. */
  VISIT_TOO_LONG: 'VISIT_TOO_LONG',
  VISIT_ENDS_BEFORE_START: 'VISIT_ENDS_BEFORE_START',
  /**
   * A receiver is an adult who lives in the unit, or an active domestic
   * worker of the unit.
   */
  RECEIVER_NOT_ELIGIBLE: 'RECEIVER_NOT_ELIGIBLE',
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
  unprocessable: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code, message, extra),
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
