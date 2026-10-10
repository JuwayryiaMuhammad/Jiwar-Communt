/** The backend's error envelope (AllExceptionsFilter, ADR 0013). */
export interface FieldErrorBody {
  field: string;
  code: string;
  params?: Record<string, unknown>;
}

export interface ApiErrorBody {
  statusCode?: number;
  code?: string;
  message?: string;
  params?: Record<string, unknown>;
  fields?: FieldErrorBody[];
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly fields: FieldErrorBody[] = [],
    readonly params: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }

  static from(status: number, body: ApiErrorBody | undefined): ApiError {
    const code =
      typeof body?.code === 'string'
        ? body.code
        : status === 0
          ? 'NETWORK_ERROR'
          : 'REQUEST_FAILED';
    return new ApiError(
      status,
      code,
      Array.isArray(body?.fields) ? body.fields : [],
      body?.params && typeof body.params === 'object' ? body.params : {},
      body?.requestId,
    );
  }

  fieldError(field: string): FieldErrorBody | undefined {
    return this.fields.find((f) => f.field === field);
  }
}

/**
 * English text for the codes the dashboards can hit. The API never sends
 * display text; `message` is for developers. An unknown code falls back to a
 * generic sentence, never to the raw `message`.
 */
const ERROR_TEXT: Record<string, string> = {
  NETWORK_ERROR: 'Could not reach the server. Check your connection.',
  VALIDATION_FAILED: 'Some fields need attention.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  FORBIDDEN: 'Your role does not allow this.',
  NOT_FOUND: 'Not found.',
  CONFLICT: 'This changed in the meantime. Refresh and try again.',
  DUPLICATE_RESOURCE: 'This already exists.',
  RELATED_RESOURCE_MISSING: 'Something this refers to no longer exists.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side.',
  REQUEST_FAILED: 'The request failed.',
  OTP_INVALID: 'That code is wrong or has expired.',
  LOGIN_TICKET_INVALID: 'The sign-in took too long. Start again.',
  REFRESH_TOKEN_INVALID: 'Your session has ended. Sign in again.',
  INVALID_CREDENTIALS: 'Email or password is wrong.',
  PASSWORD_CHANGE_REQUIRED: 'Change your password to continue.',
  TENANT_NOT_FOUND: 'Compound not found.',
  UNIT_NOT_FOUND: 'Unit not found.',
  ACCOUNT_NOT_FOUND: 'Account not found.',
  CANNOT_CHANGE_OWN_STATUS: 'You cannot change the status of your own account.',
  ACCOUNT_FROZEN: 'This account is frozen.',
  ACCOUNT_NOT_FROZEN: 'This account is not frozen.',
  ACCOUNT_PHONE_MUST_CHANGE: 'Set a new phone number to reactivate this account.',
  PHONE_RELEASED: 'That phone number was released by a frozen account.',
  OCCUPANCY_NOT_FOUND: 'Occupancy not found.',
  OCCUPANCY_ALREADY_ACTIVE: 'This person already occupies the unit.',
  PRIMARY_MUST_RESIDE: 'The primary resident must live in the unit.',
  HOUSEHOLD_UNDER_REVIEW: 'This unit is under review.',
  REVIEW_FLAG_NOT_FOUND: 'Review flag not found.',
  REVIEW_NEEDS_DECISION: 'Decide on each member before clearing the review.',
  REGISTRATION_NOT_FOUND: 'Registration request not found.',
  REGISTRATION_LINK_NOT_FOUND: 'Registration link not found.',
  REGISTRATION_CONFLICT: 'This request conflicts with existing data.',
  NO_ROLE_FOR_ACCOUNT_TYPE: 'No role exists for this account type.',
  ROLE_NOT_FOUND: 'Role not found.',
  UNKNOWN_PERMISSION: 'Unknown permission.',
  PERMISSION_NOT_ASSIGNABLE: 'This permission cannot be given to this role.',
  ROLE_LOCKOUT: 'The manager role must keep these permissions, or no one could manage the compound.',
  HOUSEHOLD_MEMBER_NOT_FOUND: 'Household member not found.',
  REASON_REQUIRED: 'A reason is required.',
  WORKER_UNDERAGE: 'The worker is under 18.',
  WORKER_BLOCKED_BY_MANAGEMENT: 'This worker is banned by management.',
  WORKER_NOT_FOUND: 'Worker not found.',
  ENGAGEMENT_NOT_FOUND: 'Worker registration not found.',
  BIRTH_DATE_CONFIRMATION_REQUIRED: 'Confirm the birth date from the passport first.',
  WORKER_COMPLIANCE_HOLD: 'This worker has an open compliance case.',
  COMPLIANCE_CASE_NOT_FOUND: 'Compliance case not found.',
  CARD_INCIDENT_NOT_FOUND: 'Card incident not found.',
  GATE_NOT_FOUND: 'Gate not found.',
  LEGAL_HOLD_ACTIVE: 'This account is on legal hold.',
  SCOPE_CONFIRMATION_MISMATCH: 'The typed phrase does not match.',
  STORAGE_UNAVAILABLE: 'File storage is unavailable right now.',
  NO_DASHBOARD_ACCESS: 'This account has no access to the management dashboard.',
  TICKET_NOT_FOUND: 'Ticket not found.',
  TICKET_CATEGORY_NOT_FOUND: 'Category not found.',
  TECHNICIAN_NOT_FOUND: 'That technician cannot take tickets: not found, inactive or without the role.',
  SPECIALTY_NOT_FOUND: 'Specialty not found.',
  DISPATCH_BUSY: 'Dispatch is deciding on this ticket right now. Try again in a moment.',
  TICKET_INVALID_TRANSITION: 'The ticket has moved on, so this is no longer possible. Refresh to see where it stands.',
  TICKET_ACTION_NOT_ALLOWED: 'This action is not allowed on this ticket.',
  TICKETS_NOT_ALLOWED: 'Tickets are not allowed for this person in this unit.',
  VISIT_NOT_FOUND: 'Visit not found.',
  VISIT_ALREADY_ACTIVE: 'This ticket already has a visit proposed or confirmed.',
  VISIT_INVALID_TRANSITION: 'The visit has moved on, so this is no longer possible.',
  VISIT_SAME_SIDE: 'The other side has to answer this proposal.',
  VISIT_NOT_FOR_COMMON_AREA: 'Visits are for tickets in a unit.',
  VISIT_WINDOW_PASSED: 'That visit window has already passed.',
  VISITS_NOT_ALLOWED: 'Visits are not allowed on this ticket.',
};

const FIELD_TEXT: Record<string, string> = {
  FIELD_REQUIRED: 'Required.',
  FIELD_NOT_ALLOWED: 'Not allowed here.',
  INVALID_TYPE: 'Wrong type.',
  INVALID_PHONE: 'Not a valid phone number.',
  INVALID_EMAIL: 'Not a valid email address.',
  INVALID_NATIONAL_ID: 'Not a valid 14-digit Egyptian national ID.',
  INVALID_PASSPORT_NUMBER: 'Not a valid passport number.',
  INVALID_NATIONALITY: 'Use a two-letter country code, e.g. EG.',
  BIRTH_DATE_REQUIRED: 'Birth date is required for a passport.',
  INVALID_BIRTH_DATE: 'Not a valid birth date.',
  INVALID_REASON_CODE: 'Pick a reason from the list.',
  INVALID_UUID: 'Not a valid id.',
  INVALID_LENGTH: 'Wrong length.',
  INVALID_FORMAT: 'Wrong format.',
  INVALID_NUMBER: 'Not a valid number.',
  INVALID_VALUE: 'Not an allowed value.',
  DUPLICATE_VALUE: 'Already in use.',
  SAME_AS_CURRENT: 'Same as the current value.',
  REPORTER_NOT_ELIGIBLE: 'This person may not open tickets for this place.',
  CATEGORY_NOT_FOR_COMMON_AREA: 'This category is for units only, not for common areas.',
  CATEGORY_NOT_AVAILABLE: 'This category is no longer in use.',
  SPECIALTY_NOT_AVAILABLE: 'This specialty is no longer in use.',
  VISIT_TOO_SOON: 'Too soon: a visit needs at least 15 minutes of notice.',
  VISIT_TOO_FAR: 'Too far ahead: at most 30 days.',
  VISIT_TOO_LONG: 'Too long: a visit window is at most 4 hours.',
  VISIT_ENDS_BEFORE_START: 'The end must be after the start.',
  VISIT_OUTSIDE_HOURS: "Outside the compound's visiting hours.",
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return ERROR_TEXT[error.code] ?? 'The request failed.';
  }
  return 'Something went wrong.';
}

export function fieldText(code: string, params?: Record<string, unknown>): string {
  const base = FIELD_TEXT[code] ?? 'Invalid value.';
  if (code === 'INVALID_LENGTH' && params) {
    const { min, max } = params as { min?: number; max?: number };
    if (min !== undefined && max !== undefined) return `Between ${min} and ${max} characters.`;
    if (max !== undefined) return `At most ${max} characters.`;
    if (min !== undefined) return `At least ${min} characters.`;
  }
  return base;
}

/** Field-level message from a VALIDATION_FAILED (or similar) error. */
export function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const f = error.fields.find((x) => x.field === field || x.field.startsWith(field + '.'));
  return f ? fieldText(f.code, f.params) : undefined;
}
