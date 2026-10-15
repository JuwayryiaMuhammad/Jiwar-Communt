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
  WAGE_NOT_PAYABLE: 'Nobody worked on this registration, so there is no wage to record.',
  WAGE_PERIOD_ALREADY_PAID: 'That month is already recorded as paid.',
  WAGE_OBLIGATION_NOT_OPEN: 'This worker has no open wage obligation: it was already closed.',
  GATE_NOT_FOUND: 'Gate not found.',
  LEGAL_HOLD_ACTIVE: 'This account is on legal hold.',
  SCOPE_CONFIRMATION_MISMATCH: 'The typed phrase does not match.',
  LEGAL_HOLD_NOT_FOUND: 'Legal hold not found, or already released.',
  OCCUPANCY_NOT_CONVERTIBLE: 'Only an active tenant occupancy can become an owner occupancy.',
  SEPARATION_MANAGER_DECISION: 'During a separation, removing an adult or their access is a manager decision.',
  MEMBER_PERMISSION_MISSING: 'This member does not have that permission.',
  MEMBER_HAS_NO_ACCOUNT: 'This member has no account, so there is nothing to revoke.',
  PARCEL_NOT_FOUND: 'Parcel not found.',
  NOTIFICATION_NOT_FOUND: 'Notification not found.',
  SESSION_NOT_FOUND: 'That session has already ended.',
  FILE_NOT_FOUND: 'File not found.',
  FILE_UPLOAD_MISSING: 'The upload did not arrive. Choose the file again.',
  FILE_UPLOAD_EXPIRED: 'The upload took too long. Choose the file again.',
  FILE_CONTENT_MISMATCH: 'The file is not what its name says it is. Choose a real image.',
  FILE_PENDING_LIMIT: 'Too many unfinished uploads. Wait a few minutes and try again.',
  FILE_NOT_AVAILABLE: 'That file can no longer be used. Upload it again.',
  DELETION_ALREADY_REQUESTED: 'A deletion is already pending for this account.',
  DELETION_REQUEST_NOT_FOUND: 'There is no open deletion request.',
  DELETION_GRACE_OVER: 'The cooling-off has ended, so the request can no longer be cancelled here.',
  DELETION_GRACE_NOT_OVER: 'The cooling-off is not over yet: the person can still change their mind.',
  DELETION_BLOCKED: 'This account cannot be deleted yet: something still depends on it.',
  DATA_EXPORT_ACTIVE: 'An export is already being prepared for this account.',
  DATA_EXPORT_RATE_LIMITED: 'Too many exports recently. Try again later.',
  ACCOUNT_HAS_NO_EMAIL: 'This account has no email address to send the export to.',
  CONSENT_VERSION_MISMATCH: 'The consent text has changed. Refresh and try again.',
  STORAGE_UNAVAILABLE: 'File storage is unavailable right now.',
  NO_DASHBOARD_ACCESS: 'This account has no access to the management dashboard.',
  TICKET_NOT_FOUND: 'Ticket not found.',
  TICKET_CATEGORY_NOT_FOUND: 'Category not found.',
  TECHNICIAN_NOT_FOUND: 'That technician cannot take tickets: not found, inactive or without the role.',
  SPECIALTY_NOT_FOUND: 'Specialty not found.',
  DISPATCH_BUSY: 'Dispatch is deciding on this ticket right now. Try again in a moment.',
  TICKET_INVALID_TRANSITION: 'The ticket has moved on, so this is no longer possible. Refresh to see where it stands.',
  // Requests to the management (ADR 0039).
  MANAGEMENT_REQUEST_NOT_FOUND: 'This request does not exist.',
  MANAGEMENT_TOPIC_NOT_FOUND: 'This topic does not exist.',
  MANAGEMENT_REQUEST_INVALID_TRANSITION: 'The request has moved on, so this is no longer possible. Refresh to see where it stands.',
  MANAGEMENT_REQUEST_NOT_AN_APPOINTMENT: 'This request is not an appointment.',
  MANAGEMENT_APPOINTMENT_SLOT_FULL: 'That slot has just been taken. Pick another.',
  MANAGEMENT_APPOINTMENT_INVALID_STATE: 'The appointment has changed, so this is no longer possible. Refresh to see where it stands.',
  MANAGEMENT_APPOINTMENT_WINDOW_PASSED: 'The appointment’s time has passed.',
  // Community life (ADR 0040).
  SUGGESTION_TOPIC_NOT_FOUND: 'This topic does not exist.',
  ANNOUNCEMENT_NOT_FOUND: 'This announcement does not exist.',
  ANNOUNCEMENT_INVALID_STATE: 'The announcement has moved on, so this is no longer possible. Refresh to see where it stands.',
  COMMUNITY_EVENT_NOT_FOUND: 'This event does not exist.',
  COMMUNITY_EVENT_INVALID_STATE: 'The event has started, ended or been cancelled, so this is no longer possible.',
  COMMUNITY_EVENT_FULL: 'The event has no room left for this answer.',
  POLL_NOT_FOUND: 'This poll does not exist.',
  POLL_INVALID_STATE: 'The poll has moved on, so this is no longer possible. Refresh to see where it stands.',
  POLL_VOTE_NOT_ALLOWED: 'This account does not cast a unit’s vote in this poll.',
  SUGGESTION_NOT_FOUND: 'This suggestion does not exist.',
  SUGGESTION_INVALID_STATE: 'The suggestion does not take this as it stands. Refresh to see where it is.',
  // Neighbours (ADR 0042).
  NEIGHBOUR_COMPLAINT_CATEGORY_NOT_FOUND: 'This category does not exist.',
  NEIGHBOUR_COMPLAINT_NOT_FOUND: 'This complaint does not exist.',
  NEIGHBOUR_COMPLAINT_INVALID_TRANSITION: 'The complaint has moved on, so this is no longer possible. Refresh to see where it stands.',
  NEIGHBOUR_COMPLAINT_LIMIT_REACHED: 'This resident already has as many open complaints as the compound allows.',
  NEIGHBOUR_NOTICE_NOT_SENT: 'The unit has not been sent its notice yet: send the notice first.',
  NEIGHBOUR_NOTICE_ALREADY_SENT: 'This complaint already has its notice: a complaint has only one. Write in the unit’s thread instead.',
  NEIGHBOUR_NOTICE_NO_RECIPIENT: 'Nobody lives in this unit and nobody owns it: there is no one to send a notice to.',
  NEIGHBOUR_NOTICE_NOT_FOUND: 'This notice does not exist.',
  NEIGHBOUR_POST_NOT_FOUND: 'This post does not exist.',
  NEIGHBOUR_POST_NOT_OPEN: 'The post is closed, so this is no longer possible. Refresh to see where it stands.',
  NEIGHBOUR_POST_LIMIT_REACHED: 'This account already has as many posts on the boards as the compound allows.',
  NEIGHBOUR_POST_NOT_CLAIMABLE: 'Only a found item is claimed and handed over.',
  NEIGHBOUR_CLAIM_NOT_FOUND: 'This claim does not exist.',
  NEIGHBOUR_CLAIM_EXISTS: 'This person already has a claim waiting on the item.',
  NEIGHBOUR_CLAIM_INVALID_STATE: 'The claim is no longer waiting for a decision. Refresh to see what became of it.',
  NEIGHBOUR_POST_NO_CONTACT: 'There is nobody to write to about this post.',
  NEIGHBOUR_CONVERSATION_NOT_FOUND: 'This conversation does not exist.',
  NEIGHBOUR_CONVERSATION_EXISTS: 'There is already a conversation about this post.',
  NEIGHBOUR_CONVERSATION_CLOSED: 'Nothing more is written in this conversation.',
  NEIGHBOUR_CONVERSATION_LIMIT_REACHED: 'As many new conversations were started today as the compound allows.',
  NEIGHBOUR_NAMES_ALREADY_REVEALED: 'Names are already shown in this conversation.',
  NEIGHBOUR_BLOCK_NOT_FOUND: 'This block does not exist.',
  NEIGHBOUR_REPORT_NOT_FOUND: 'This report does not exist.',
  NEIGHBOUR_REPORT_EXISTS: 'This conversation was already reported.',
  NEIGHBOUR_REPORT_CLOSED: 'This case is closed. The conversation is sealed again.',
  TICKET_ACTION_NOT_ALLOWED: 'This action is not allowed on this ticket.',
  TICKETS_NOT_ALLOWED: 'Tickets are not allowed for this person in this unit.',
  VISIT_NOT_FOUND: 'Visit not found.',
  VISIT_ALREADY_ACTIVE: 'This ticket already has a visit proposed or confirmed.',
  VISIT_INVALID_TRANSITION: 'The visit has moved on, so this is no longer possible.',
  VISIT_SAME_SIDE: 'The other side has to answer this proposal.',
  VISIT_NOT_FOR_COMMON_AREA: 'Visits are for tickets in a unit.',
  VISIT_WINDOW_PASSED: 'That visit window has already passed.',
  VISITS_NOT_ALLOWED: 'Visits are not allowed on this ticket.',
  PREVENTIVE_SERVICE_NOT_FOUND: 'Preventive service not found.',
  // Facilities and bookings, the club (ADR 0044).
  FACILITY_NOT_FOUND: 'This facility does not exist.',
  FACILITY_NOT_BOOKABLE: 'This facility is walk-in: it takes no booking and has no peak times.',
  FACILITY_CLOSED: 'The facility is closed at that time.',
  FACILITY_CLOSURE_NOT_FOUND: 'This closure does not exist.',
  FACILITY_CLOSURE_LIFTED: 'This closure was lifted already.',
  BOOKING_NOT_FOUND: 'This booking does not exist.',
  BOOKINGS_NOT_ALLOWED: 'This person may not book for this unit.',
  BOOKINGS_SUSPENDED: 'This unit is suspended from booking for now.',
  BOOKING_SLOT_FULL: 'The slot has no room left.',
  BOOKING_ALREADY_HELD: 'The unit already holds this slot.',
  BOOKING_QUOTA_REACHED: 'The unit has as many bookings here as a week allows.',
  BOOKING_INVALID_TRANSITION: 'The booking has moved on, so this is no longer possible. Refresh to see where it stands.',
  BOOKING_CANCEL_CUTOFF_PASSED: 'Too late to cancel this booking.',
  BOOKING_WINDOW_PASSED: 'The booking’s time has passed.',
  BOOKING_NOT_OVER: 'The slot has not ended yet: nobody can tell it was a no-show.',
  BOOKING_NO_SHOW_TOO_LATE: 'A no-show is marked within three days of the slot.',
  BOOKING_SUSPENSION_NOT_FOUND: 'This suspension does not exist.',
  BOOKING_SUSPENSION_NOT_IN_FORCE: 'This suspension is over or was lifted already.',
  CLUB_MEMBERSHIP_REQUIRED: 'This facility is for club members.',
  CLUB_PLAN_NOT_FOUND: 'This plan does not exist.',
  CLUB_MEMBERSHIP_NOT_FOUND: 'This membership does not exist.',
  CLUB_MEMBERSHIP_EXISTS: 'This unit already has a membership.',
  CLUB_PAYMENT_NOT_FOUND: 'This payment does not exist.',
  CLUB_PAYMENT_ALREADY_REVERSED: 'This payment was reversed already.',
  // Vehicles and parking (ADR 0045).
  VEHICLE_NOT_FOUND: 'This vehicle does not exist.',
  VEHICLES_NOT_ALLOWED: 'This person may not register vehicles for this unit.',
  VEHICLE_ACTION_NOT_ALLOWED: 'Only the person who registered the vehicle, or the unit’s primary resident, may change it.',
  VEHICLE_LIMIT_REACHED: 'The unit has as many vehicles as the compound allows.',
  VEHICLE_INVALID_TRANSITION: 'The vehicle has moved on, so this is no longer possible. Refresh to see where it stands.',
  VEHICLE_CHANGED: 'The vehicle’s plate changed since you opened it. Check it again before deciding.',
  VEHICLE_PLATE_ACTIVE: 'Another vehicle already holds an active permit for this plate.',
  PARKING_SLOT_NOT_FOUND: 'This parking slot does not exist.',
  VISITOR_PARKING_AREA_NOT_FOUND: 'This visitor parking area does not exist.',
  VISITOR_PARKING_BOOKING_NOT_FOUND: 'This visitor parking booking does not exist.',
  VISITOR_PARKING_NOT_ALLOWED: 'This person may not book visitor parking for this unit.',
  VISITOR_PARKING_FULL: 'The area has no space left for that time.',
  VISITOR_PARKING_LIMIT_REACHED: 'The unit holds as many visitor parking bookings as the compound allows.',
  VISITOR_PARKING_INVALID_TRANSITION: 'This booking was cancelled already.',
  VISITOR_PARKING_WINDOW_PASSED: 'This booking has ended.',
  VEHICLE_FINE_NOT_FOUND: 'This fine does not exist.',
  FINES_NOT_ALLOWED: 'This person may not see this unit’s fines.',
  FINE_APPEAL_NOT_ALLOWED: 'Only the unit’s vehicle keepers or its primary resident may appeal.',
  FINE_APPEAL_CLOSED: 'This fine takes no appeal: appealed already, paid or cancelled.',
  FINE_APPEAL_WINDOW_PASSED: 'The time to appeal this fine has passed.',
  FINE_NOT_UNDER_APPEAL: 'This fine is not under appeal.',
  FINE_NOT_CANCELLABLE: 'Only an unpaid fine that is not under appeal can be cancelled.',
  FINE_UNDER_APPEAL: 'This fine is under appeal: record its payment once the appeal is decided.',
  FINE_NOT_PAYABLE: 'This fine is paid already or cancelled.',
  FINE_PAYMENT_NOT_FOUND: 'This payment does not exist.',
  FINE_PAYMENT_ALREADY_REVERSED: 'This payment was reversed already.',
  PARKING_REPORT_NOT_FOUND: 'This parking report does not exist.',
  PARKING_REPORT_NOT_ALLOWED: 'Only residents report parking.',
  PARKING_REPORT_LIMIT_REACHED: 'As many reports are open as a resident may have.',
  PARKING_REPORT_CLOSED: 'This report was dealt with already.',
  PLACE_NOT_FOUND: 'This place does not exist.',
  EMERGENCY_NOT_FOUND: 'This emergency does not exist.',
  EMERGENCY_CLOSED: 'This emergency was resolved or cancelled already.',
  EMERGENCY_ACTION_NOT_ALLOWED: 'You cannot do this on this emergency.',
  EMERGENCY_ALREADY_ACCEPTED: 'Another responder accepted this emergency first.',
  EMERGENCY_NOT_RESPONDER: 'Only the responder who accepted this emergency can do this.',
  EMERGENCY_NOT_ON_THE_WAY: 'Nobody is on the way to this emergency yet.',
  STEP_UP_REQUIRED: 'Confirm with the code we email you first.',
  STEP_UP_CODE_INVALID: 'That code is wrong or has expired.',
  PAYMENT_VAULT_UNAVAILABLE: 'The server is not set up to store payment credentials yet. Ask the platform team.',
  GATEWAY_NOT_CONFIGURED: 'Set the payment account’s credentials first.',
  INVOICE_NOT_FOUND: 'This invoice does not exist.',
  INVOICE_BATCH_NOT_FOUND: 'This issue does not exist.',
  INVOICE_BATCH_EMPTY: 'No unit matches: nothing was issued.',
  INVOICE_BATCH_TOO_LARGE: 'Too many units for one issue: split it by building.',
  CREDIT_EXCEEDS_OUTSTANDING: 'A credit note cannot be more than the invoice still asks for.',
  BILLING_PLAN_NOT_FOUND: 'This billing plan does not exist.',
  BILLING_OVERRIDE_NOT_FOUND: 'This unit has no terms of its own in the plan.',
  PAYMENT_NOT_FOUND: 'This payment does not exist.',
  PAYMENT_NOT_REVERSIBLE: 'An online payment cannot be reversed here.',
  PAYMENT_ALREADY_REVERSED: 'This payment was reversed already.',
  PAYMENT_EXCEEDS_OUTSTANDING: 'More than the unit owes: record at most what is outstanding.',
  INVOICE_NOT_PAYABLE: 'One of these invoices is not this unit’s, or nothing is owed on it.',
  NOTHING_TO_PAY: 'Nothing is owed.',
  ONLINE_PAYMENT_UNAVAILABLE: 'Online payment is not available in this compound now.',
  PAYMENT_SESSION_IN_FLIGHT: 'A checkout is being opened: try again in a moment.',
  PAYMENT_GATEWAY_ERROR: 'The payment provider could not open the checkout. Try again.',
  PAYMENT_SESSION_NOT_FOUND: 'This checkout does not exist.',
  RECEIPT_NOT_FOUND: 'No receipt has this code.',
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
  FILE_TYPE_NOT_ALLOWED: 'This kind of file is not accepted here.',
  FILE_TOO_LARGE: 'The file is too large.',
  CATEGORY_NOT_FOR_COMMON_AREA: 'This category is for units only, not for common areas.',
  CATEGORY_NOT_AVAILABLE: 'This category is no longer in use.',
  SPECIALTY_NOT_AVAILABLE: 'This specialty is no longer in use.',
  VISIT_TOO_SOON: 'Too soon: a visit needs at least 15 minutes of notice.',
  VISIT_TOO_FAR: 'Too far ahead: at most 30 days.',
  VISIT_TOO_LONG: 'Too long: a visit window is at most 4 hours.',
  VISIT_ENDS_BEFORE_START: 'The end must be after the start.',
  VISIT_OUTSIDE_HOURS: "Outside the compound's visiting hours.",
  VISIT_HOURS_TOO_SHORT: 'The visiting hours must hold at least one slot.',
  // Requests to the management (ADR 0039).
  OFFICE_HOURS_OVERLAP: 'Overlaps another window of the same day.',
  TOPIC_NOT_AVAILABLE: 'Pick an active topic.',
  AUTHOR_NOT_ELIGIBLE: 'Pick an active resident or family account.',
  ASSIGNEE_NOT_ELIGIBLE: 'This account cannot handle requests.',
  APPOINTMENT_SLOT_NOT_OFFERED: 'Pick one of the offered slots.',
  APPOINTMENT_TOO_SOON: 'An appointment starts at least an hour from now.',
  APPOINTMENT_TOO_FAR: 'An appointment starts within thirty days.',
  ENDS_BEFORE_START: 'The end must come after the start.',
  INVALID_SCHEDULE: 'A window ends after it starts.',
  // Neighbours (ADR 0042).
  UNIT_CODE_UNKNOWN: 'No unit of the compound has this code.',
  OWN_UNIT: 'This is one of the complainant’s own units.',
  RECIPIENT_NOT_ELIGIBLE: 'Pick an active resident or family account of this compound.',
  WAGE_PERIOD_IN_FUTURE: 'That month has not started yet.',
  WAGE_PERIOD_BEFORE_ENGAGEMENT: 'That month is before the worker was registered.',
  SLA_RESPONSE_AFTER_RESOLUTION: 'The response target cannot be longer than the resolution target.',
  // Facilities and bookings, the club (ADR 0044).
  WINDOW_OVERLAP: 'Overlaps another window of the same day.',
  PEAK_OUTSIDE_HOURS: 'A peak time must lie inside the opening hours.',
  PEAK_QUOTA_ABOVE_WEEKLY: 'At most the weekly quota.',
  BOOKING_SLOT_NOT_OFFERED: 'Not one of the facility’s slots.',
  BOOKING_TOO_SOON: 'Too soon for this facility.',
  BOOKING_TOO_FAR: 'Too far ahead for this facility.',
  BOOKING_TOO_MANY_GUESTS: 'More guests than the facility takes.',
  BOOKING_PARTY_TOO_LARGE: 'More people than a slot takes.',
  CLOSURE_TOO_LONG: 'A closure lasts at most 366 days.',
  CLOSURE_ENDED: 'That time has already passed.',
  PLAN_NOT_AVAILABLE: 'Pick an active plan.',
  PAID_ON_OUT_OF_RANGE: 'Not in the future, and at most 90 days ago.',
  PERSON_NOT_OF_UNIT: 'Not one of the unit’s people now.',
  PERMIT_DATE_OUT_OF_RANGE: 'Pick a day after today, at most two years ahead.',
  AREA_NOT_AVAILABLE: 'Not an active visitor parking area.',
  PASS_NOT_AVAILABLE: 'Not an active visitor pass of this unit that you manage.',
  PARKING_TOO_EARLY: 'That start has passed.',
  PARKING_TOO_FAR: 'Too far ahead.',
  PARKING_TOO_SHORT: 'Too short.',
  PARKING_TOO_LONG: 'Longer than the compound allows.',
  PARKING_OUTSIDE_PASS: 'Outside the visitor pass’s validity.',
  VEHICLE_NOT_OF_UNIT: 'Not one of the unit’s vehicles.',
  DAY_OUT_OF_RANGE: 'Pick a day in range.',
  AMOUNT_MISMATCH: 'Not the fine’s amount: a fine is paid in full.',
  GATEWAY_MODE_MISMATCH: 'Live mode takes live keys, sandbox takes test keys.',
  DUE_ON_OUT_OF_RANGE: 'From today to a year ahead.',
  INVOICE_TOTAL_TOO_LARGE: 'An invoice asks for at most 1,000,000 EGP.',
  STARTS_ON_OUT_OF_RANGE: 'From the first of this month to a year ahead.',
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
  if (code === 'INVALID_NUMBER' && params) {
    const { min, max } = params as { min?: number; max?: number };
    if (min !== undefined && max !== undefined) return `A number from ${min} to ${max}.`;
    if (max !== undefined) return `At most ${max}.`;
    if (min !== undefined) return `At least ${min}.`;
  }
  return base;
}

/** Field-level message from a VALIDATION_FAILED (or similar) error. */
export function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const f = error.fields.find((x) => x.field === field || x.field.startsWith(field + '.'));
  return f ? fieldText(f.code, f.params) : undefined;
}
