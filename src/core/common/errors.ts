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
  /** A push token is registered per install: the header is missing (ADR 0041). */
  INSTALL_ID_REQUIRED: 'INSTALL_ID_REQUIRED',
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
  /** Pending or rejected: nobody worked, nothing to pay (409, ADR 0037). */
  WAGE_NOT_PAYABLE: 'WAGE_NOT_PAYABLE',
  /** That month already has a payment (409, params.period). */
  WAGE_PERIOD_ALREADY_PAID: 'WAGE_PERIOD_ALREADY_PAID',
  /** No open wage obligation to settle on this engagement (409, ADR 0037). */
  WAGE_OBLIGATION_NOT_OPEN: 'WAGE_OBLIGATION_NOT_OPEN',
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
  /** A gate action, and the open shift is in a zone (a 403, ADR 0050). */
  SHIFT_NOT_AT_GATE: 'SHIFT_NOT_AT_GATE',
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
  // standing instructions (ADR 0043)
  /** Unknown, another unit's, or its author may no longer invite there. */
  STANDING_INSTRUCTION_NOT_FOUND: 'STANDING_INSTRUCTION_NOT_FOUND',
  /** The unit has as many as allowed (params.max). */
  STANDING_INSTRUCTION_LIMIT_REACHED: 'STANDING_INSTRUCTION_LIMIT_REACHED',
  /** The compound's manager turned `always_allow` off. */
  ALWAYS_ALLOW_DISABLED: 'ALWAYS_ALLOW_DISABLED',
  /** `call_first`: the household answers, not the instruction. */
  STANDING_INSTRUCTION_CALL_FIRST: 'STANDING_INSTRUCTION_CALL_FIRST',
  /** A worker off schedule is the household's to answer. */
  STANDING_INSTRUCTION_NOT_APPLICABLE: 'STANDING_INSTRUCTION_NOT_APPLICABLE',
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
  /** Unknown, or another compound's (ADR 0038). */
  PREVENTIVE_SERVICE_NOT_FOUND: 'PREVENTIVE_SERVICE_NOT_FOUND',
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
  /** No SLA commitment of the ticket is late and unmet (409, ADR 0038). */
  TICKET_NOT_OVERDUE: 'TICKET_NOT_OVERDUE',
  /** Escalated already in this SLA cycle (409, ADR 0038). */
  TICKET_ALREADY_ESCALATED: 'TICKET_ALREADY_ESCALATED',
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
  /** The residents' side already confirmed this arrival (409, ADR 0038). */
  VISIT_ARRIVAL_ALREADY_CONFIRMED: 'VISIT_ARRIVAL_ALREADY_CONFIRMED',
  /** The proposal's start has passed: counter or cancel it (409, ADR 0038). */
  VISIT_WINDOW_PASSED: 'VISIT_WINDOW_PASSED',
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
  /** The action needs a fresh step-up code on this session (403). */
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  /** A wrong, used or expired step-up code (403). */
  STEP_UP_CODE_INVALID: 'STEP_UP_CODE_INVALID',
  /** Unknown, or another account's (ADR 0036). */
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  /** An email link that is unknown, expired, used up or for something else (404). */
  ACTION_TOKEN_INVALID: 'ACTION_TOKEN_INVALID',
  /** Unknown, another account's, not ready or expired (ADR 0036). */
  DATA_EXPORT_NOT_FOUND: 'DATA_EXPORT_NOT_FOUND',
  /** An export is already pending or being built (409). */
  DATA_EXPORT_ACTIVE: 'DATA_EXPORT_ACTIVE',
  /** One request a day (429, params.retryAfter). */
  DATA_EXPORT_RATE_LIMITED: 'DATA_EXPORT_RATE_LIMITED',
  /** A frozen or erased account (409). */
  ACCOUNT_NOT_ELIGIBLE: 'ACCOUNT_NOT_ELIGIBLE',
  /** An assisted export goes only to the account's own email (409). */
  ACCOUNT_HAS_NO_EMAIL: 'ACCOUNT_HAS_NO_EMAIL',
  /**
   * Something keeps the account from being deleted now (409,
   * params.blockers: primary_resident, active_staff_role, legal_hold,
   * open_worker_obligations).
   */
  DELETION_BLOCKED: 'DELETION_BLOCKED',
  // requests to the management (ADR 0039)
  /** Unknown, or another compound's. */
  MANAGEMENT_TOPIC_NOT_FOUND: 'MANAGEMENT_TOPIC_NOT_FOUND',
  /** Unknown, another compound's, or not the caller's own: one answer. */
  MANAGEMENT_REQUEST_NOT_FOUND: 'MANAGEMENT_REQUEST_NOT_FOUND',
  /** The request's status does not take the action (409, params.status). */
  MANAGEMENT_REQUEST_INVALID_TRANSITION:
    'MANAGEMENT_REQUEST_INVALID_TRANSITION',
  /** Closed more than seven days ago (409, params.reopenDays). */
  MANAGEMENT_REQUEST_REOPEN_WINDOW_PASSED:
    'MANAGEMENT_REQUEST_REOPEN_WINDOW_PASSED',
  /** A request is rated once (409). */
  MANAGEMENT_REQUEST_ALREADY_RATED: 'MANAGEMENT_REQUEST_ALREADY_RATED',
  /** An appointment action on a request of another type (409). */
  MANAGEMENT_REQUEST_NOT_AN_APPOINTMENT:
    'MANAGEMENT_REQUEST_NOT_AN_APPOINTMENT',
  /** The slot already holds as many appointments as it takes (409). */
  MANAGEMENT_APPOINTMENT_SLOT_FULL: 'MANAGEMENT_APPOINTMENT_SLOT_FULL',
  /**
   * The request's appointment does not take the action (409); params.status
   * is its status, or `none` when it has no live one.
   */
  MANAGEMENT_APPOINTMENT_INVALID_STATE: 'MANAGEMENT_APPOINTMENT_INVALID_STATE',
  /** Its start has passed: nothing left to confirm (409). */
  MANAGEMENT_APPOINTMENT_WINDOW_PASSED: 'MANAGEMENT_APPOINTMENT_WINDOW_PASSED',
  // community life (ADR 0040)
  /** Unknown, or another compound's. */
  SUGGESTION_TOPIC_NOT_FOUND: 'SUGGESTION_TOPIC_NOT_FOUND',
  /**
   * Unknown or another compound's; for a resident also not out yet, over,
   * or not put to them: one answer.
   */
  ANNOUNCEMENT_NOT_FOUND: 'ANNOUNCEMENT_NOT_FOUND',
  /** Its state does not take the action (409, params.status). */
  ANNOUNCEMENT_INVALID_STATE: 'ANNOUNCEMENT_INVALID_STATE',
  /**
   * One of the board's decisions or minutes (ADR 0051): it changes through
   * governance (`/governance/publications`), never the staff's routes (409).
   */
  ANNOUNCEMENT_OF_THE_BOARD: 'ANNOUNCEMENT_OF_THE_BOARD',
  /** Unknown, another compound's, or not put to the caller: one answer. */
  COMMUNITY_EVENT_NOT_FOUND: 'COMMUNITY_EVENT_NOT_FOUND',
  /** Its state does not take the action (409, params.status). */
  COMMUNITY_EVENT_INVALID_STATE: 'COMMUNITY_EVENT_INVALID_STATE',
  /** No room for this answer and its guests (409, params.remaining). */
  COMMUNITY_EVENT_FULL: 'COMMUNITY_EVENT_FULL',
  /**
   * Unknown, another compound's, or for a resident not open yet or not put
   * to them: one answer.
   */
  POLL_NOT_FOUND: 'POLL_NOT_FOUND',
  /** Its state does not take the action (409, params.status). */
  POLL_INVALID_STATE: 'POLL_INVALID_STATE',
  /** The caller casts no unit's vote in this poll (403). */
  POLL_VOTE_NOT_ALLOWED: 'POLL_VOTE_NOT_ALLOWED',
  /**
   * Unknown or another compound's; for a resident also not their own, or
   * (on the board) not published: one answer.
   */
  SUGGESTION_NOT_FOUND: 'SUGGESTION_NOT_FOUND',
  /**
   * It does not take the action as it stands (409, params.status,
   * params.published): a move that is not a step forward, a note on one
   * that is not done, taking down one that is not on the board.
   */
  SUGGESTION_INVALID_STATE: 'SUGGESTION_INVALID_STATE',
  // neighbours (ADR 0042)
  /** Unknown, or another compound's. */
  NEIGHBOUR_COMPLAINT_CATEGORY_NOT_FOUND:
    'NEIGHBOUR_COMPLAINT_CATEGORY_NOT_FOUND',
  /**
   * Unknown or another compound's; for a resident also anyone else's (a
   * complaint is its author's alone): one answer.
   */
  NEIGHBOUR_COMPLAINT_NOT_FOUND: 'NEIGHBOUR_COMPLAINT_NOT_FOUND',
  /** Its status does not take the action (409, params.status). */
  NEIGHBOUR_COMPLAINT_INVALID_TRANSITION:
    'NEIGHBOUR_COMPLAINT_INVALID_TRANSITION',
  /** The author has as many open complaints as the compound allows (409, params.max). */
  NEIGHBOUR_COMPLAINT_LIMIT_REACHED: 'NEIGHBOUR_COMPLAINT_LIMIT_REACHED',
  /** The unit was not sent a notice: nobody writes in its thread yet (409). */
  NEIGHBOUR_NOTICE_NOT_SENT: 'NEIGHBOUR_NOTICE_NOT_SENT',
  /** A complaint has one notice (409). */
  NEIGHBOUR_NOTICE_ALREADY_SENT: 'NEIGHBOUR_NOTICE_ALREADY_SENT',
  /** Nobody lives in the unit and nobody owns it: no one to send it to (409). */
  NEIGHBOUR_NOTICE_NO_RECIPIENT: 'NEIGHBOUR_NOTICE_NO_RECIPIENT',
  /**
   * Unknown or another compound's; or not sent to the caller; or sent to
   * them when they answered for the unit, which they no longer do: one
   * answer.
   */
  NEIGHBOUR_NOTICE_NOT_FOUND: 'NEIGHBOUR_NOTICE_NOT_FOUND',
  /**
   * Unknown or another compound's; for a resident also one that left its
   * board and is not theirs, or one they are kept from seeing: one answer.
   */
  NEIGHBOUR_POST_NOT_FOUND: 'NEIGHBOUR_POST_NOT_FOUND',
  /** It is closed, or its day has passed (409, params.state). */
  NEIGHBOUR_POST_NOT_OPEN: 'NEIGHBOUR_POST_NOT_OPEN',
  /** The author has as many posts on the boards as the compound allows (409, params.max). */
  NEIGHBOUR_POST_LIMIT_REACHED: 'NEIGHBOUR_POST_LIMIT_REACHED',
  /** Not a found item, or the caller's own post (409). */
  NEIGHBOUR_POST_NOT_CLAIMABLE: 'NEIGHBOUR_POST_NOT_CLAIMABLE',
  /** Unknown, another compound's, or (for a resident) not their own. */
  NEIGHBOUR_CLAIM_NOT_FOUND: 'NEIGHBOUR_CLAIM_NOT_FOUND',
  /** The caller already has a pending claim on the item (409). */
  NEIGHBOUR_CLAIM_EXISTS: 'NEIGHBOUR_CLAIM_EXISTS',
  /** The claim is no longer pending (409, params.status). */
  NEIGHBOUR_CLAIM_INVALID_STATE: 'NEIGHBOUR_CLAIM_INVALID_STATE',
  /** The management's post, or the caller's own: nobody to write to (409). */
  NEIGHBOUR_POST_NO_CONTACT: 'NEIGHBOUR_POST_NO_CONTACT',
  /** Unknown, another compound's, or not one the caller is part of: one answer. */
  NEIGHBOUR_CONVERSATION_NOT_FOUND: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
  /** The caller already wrote about this post (409, params.conversationId). */
  NEIGHBOUR_CONVERSATION_EXISTS: 'NEIGHBOUR_CONVERSATION_EXISTS',
  /**
   * Nothing more is written in it (409): it was closed, or its post left
   * the board. Never says why.
   */
  NEIGHBOUR_CONVERSATION_CLOSED: 'NEIGHBOUR_CONVERSATION_CLOSED',
  /** As many new conversations in 24 hours as the compound allows (409, params.max). */
  NEIGHBOUR_CONVERSATION_LIMIT_REACHED: 'NEIGHBOUR_CONVERSATION_LIMIT_REACHED',
  /** Both agreed: names are shown and stay shown (409). */
  NEIGHBOUR_NAMES_ALREADY_REVEALED: 'NEIGHBOUR_NAMES_ALREADY_REVEALED',
  /** Unknown, another compound's, or not the caller's own. */
  NEIGHBOUR_BLOCK_NOT_FOUND: 'NEIGHBOUR_BLOCK_NOT_FOUND',
  /** Unknown, or another compound's. */
  NEIGHBOUR_REPORT_NOT_FOUND: 'NEIGHBOUR_REPORT_NOT_FOUND',
  /** The caller already reported this conversation (409). */
  NEIGHBOUR_REPORT_EXISTS: 'NEIGHBOUR_REPORT_EXISTS',
  /** The case is closed: its conversation is no longer read, nor it closed again (409). */
  NEIGHBOUR_REPORT_CLOSED: 'NEIGHBOUR_REPORT_CLOSED',
  // facilities and bookings, the club (ADR 0044)
  /** Unknown or another compound's; for a resident also a retired one: one answer. */
  FACILITY_NOT_FOUND: 'FACILITY_NOT_FOUND',
  /** A walk-in facility (the pool, the gym): nothing to book, no peak times (409). */
  FACILITY_NOT_BOOKABLE: 'FACILITY_NOT_BOOKABLE',
  /**
   * Unknown or another compound's; for a resident also one they neither
   * made nor see as the unit's primary: one answer.
   */
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  /** The caller's capabilities on the unit carry no `bookings` (403). */
  BOOKINGS_NOT_ALLOWED: 'BOOKINGS_NOT_ALLOWED',
  /** Not even one more booking (or the party) fits in the slot (409). */
  BOOKING_SLOT_FULL: 'BOOKING_SLOT_FULL',
  /** The unit already holds this slot (409). */
  BOOKING_ALREADY_HELD: 'BOOKING_ALREADY_HELD',
  /**
   * Some 7 days would hold more of the unit's bookings here than the
   * facility allows (409, params.quota, params.peak: the peak quota).
   */
  BOOKING_QUOTA_REACHED: 'BOOKING_QUOTA_REACHED',
  /** Its status does not take the action (409, params.status). */
  BOOKING_INVALID_TRANSITION: 'BOOKING_INVALID_TRANSITION',
  /** A confirmed booking is cancelled at least params.minutes before it starts (409). */
  BOOKING_CANCEL_CUTOFF_PASSED: 'BOOKING_CANCEL_CUTOFF_PASSED',
  /** Its start (to approve or reject) or its end (to cancel) has passed (409). */
  BOOKING_WINDOW_PASSED: 'BOOKING_WINDOW_PASSED',
  /** The facility is closed over the slot (409). */
  FACILITY_CLOSED: 'FACILITY_CLOSED',
  /** Unknown, or another compound's. */
  FACILITY_CLOSURE_NOT_FOUND: 'FACILITY_CLOSURE_NOT_FOUND',
  /** It was lifted already (409). */
  FACILITY_CLOSURE_LIFTED: 'FACILITY_CLOSURE_LIFTED',
  /** The unit is suspended from booking until params.until, after no-shows (403). */
  BOOKINGS_SUSPENDED: 'BOOKINGS_SUSPENDED',
  /** Its slot has not ended: nobody can tell yet it was a no-show (409). */
  BOOKING_NOT_OVER: 'BOOKING_NOT_OVER',
  /** A no-show is marked within params.hours of the slot's end (409). */
  BOOKING_NO_SHOW_TOO_LATE: 'BOOKING_NO_SHOW_TOO_LATE',
  /** Unknown, or another compound's. */
  BOOKING_SUSPENSION_NOT_FOUND: 'BOOKING_SUSPENSION_NOT_FOUND',
  /** It is over, or lifted already (409). */
  BOOKING_SUSPENSION_NOT_IN_FORCE: 'BOOKING_SUSPENSION_NOT_IN_FORCE',
  /**
   * The facility is for club members: the unit's membership is not active
   * on the slot's day, or does not cover the booker (403).
   */
  CLUB_MEMBERSHIP_REQUIRED: 'CLUB_MEMBERSHIP_REQUIRED',
  /** Unknown, or another compound's. */
  CLUB_PLAN_NOT_FOUND: 'CLUB_PLAN_NOT_FOUND',
  /** Unknown, or another compound's. */
  CLUB_MEMBERSHIP_NOT_FOUND: 'CLUB_MEMBERSHIP_NOT_FOUND',
  /** The unit has a membership already (409, params.membershipId). */
  CLUB_MEMBERSHIP_EXISTS: 'CLUB_MEMBERSHIP_EXISTS',
  /** Unknown, another compound's, or not a payment. */
  CLUB_PAYMENT_NOT_FOUND: 'CLUB_PAYMENT_NOT_FOUND',
  /** It was reversed already (409). */
  CLUB_PAYMENT_ALREADY_REVERSED: 'CLUB_PAYMENT_ALREADY_REVERSED',
  // vehicles and parking (ADR 0045)
  /**
   * Unknown, another compound's or removed; for a resident also another
   * unit's, or one where they do not hold `vehicles`: one answer.
   */
  VEHICLE_NOT_FOUND: 'VEHICLE_NOT_FOUND',
  /** The caller's capabilities on the unit carry no `vehicles` (403). */
  VEHICLES_NOT_ALLOWED: 'VEHICLES_NOT_ALLOWED',
  /** Only the vehicle's registrant or the unit's primary edits or removes it (403). */
  VEHICLE_ACTION_NOT_ALLOWED: 'VEHICLE_ACTION_NOT_ALLOWED',
  /** The unit has params.max pending or active vehicles already (409). */
  VEHICLE_LIMIT_REACHED: 'VEHICLE_LIMIT_REACHED',
  /** Its status does not take the action (409, params.status). */
  VEHICLE_INVALID_TRANSITION: 'VEHICLE_INVALID_TRANSITION',
  /**
   * Its plate changed since the staff read it (409, params.version: the
   * current one): read it again before deciding.
   */
  VEHICLE_CHANGED: 'VEHICLE_CHANGED',
  /** Another vehicle of the compound holds an active permit for this plate (409). */
  VEHICLE_PLATE_ACTIVE: 'VEHICLE_PLATE_ACTIVE',
  /** Unknown, or another compound's. */
  PARKING_SLOT_NOT_FOUND: 'PARKING_SLOT_NOT_FOUND',
  /** Unknown, or another compound's. */
  VISITOR_PARKING_AREA_NOT_FOUND: 'VISITOR_PARKING_AREA_NOT_FOUND',
  /**
   * Unknown, another compound's; for a resident also one they neither
   * made nor see as the unit's primary: one answer.
   */
  VISITOR_PARKING_BOOKING_NOT_FOUND: 'VISITOR_PARKING_BOOKING_NOT_FOUND',
  /** The caller's capabilities on the unit carry no `visitorsInvite` (403). */
  VISITOR_PARKING_NOT_ALLOWED: 'VISITOR_PARKING_NOT_ALLOWED',
  /** Not one more space of the area is free for the whole window (409). */
  VISITOR_PARKING_FULL: 'VISITOR_PARKING_FULL',
  /** The unit holds params.max bookings not yet ended (409). */
  VISITOR_PARKING_LIMIT_REACHED: 'VISITOR_PARKING_LIMIT_REACHED',
  /** It was cancelled already (409, params.status). */
  VISITOR_PARKING_INVALID_TRANSITION: 'VISITOR_PARKING_INVALID_TRANSITION',
  /** It has ended (409). */
  VISITOR_PARKING_WINDOW_PASSED: 'VISITOR_PARKING_WINDOW_PASSED',
  /**
   * Unknown, another compound's; for a resident also one of a unit whose
   * fines they do not see: one answer.
   */
  VEHICLE_FINE_NOT_FOUND: 'VEHICLE_FINE_NOT_FOUND',
  /** The caller neither keeps the unit's vehicles nor sees its money (403). */
  FINES_NOT_ALLOWED: 'FINES_NOT_ALLOWED',
  /** Only the unit's vehicle keepers or its primary appeal a fine (403). */
  FINE_APPEAL_NOT_ALLOWED: 'FINE_APPEAL_NOT_ALLOWED',
  /** Appealed already, paid or cancelled (409, params.status, params.appealed). */
  FINE_APPEAL_CLOSED: 'FINE_APPEAL_CLOSED',
  /** A fine is appealed within params.days of being issued (409). */
  FINE_APPEAL_WINDOW_PASSED: 'FINE_APPEAL_WINDOW_PASSED',
  /** Only a fine under appeal is decided (409, params.status). */
  FINE_NOT_UNDER_APPEAL: 'FINE_NOT_UNDER_APPEAL',
  /** Only an unpaid fine not under appeal is cancelled (409, params.status). */
  FINE_NOT_CANCELLABLE: 'FINE_NOT_CANCELLABLE',
  /** It is under appeal: it is paid once the appeal is decided (409). */
  FINE_UNDER_APPEAL: 'FINE_UNDER_APPEAL',
  /** Paid already, or cancelled (409, params.status). */
  FINE_NOT_PAYABLE: 'FINE_NOT_PAYABLE',
  /** Unknown, another compound's, or not a payment. */
  FINE_PAYMENT_NOT_FOUND: 'FINE_PAYMENT_NOT_FOUND',
  /** It was reversed already (409). */
  FINE_PAYMENT_ALREADY_REVERSED: 'FINE_PAYMENT_ALREADY_REVERSED',
  /** Unknown, or another compound's. */
  PARKING_REPORT_NOT_FOUND: 'PARKING_REPORT_NOT_FOUND',
  /** Only someone who lives in or belongs to a unit reports parking (403). */
  PARKING_REPORT_NOT_ALLOWED: 'PARKING_REPORT_NOT_ALLOWED',
  /** The resident has params.max open reports (409). */
  PARKING_REPORT_LIMIT_REACHED: 'PARKING_REPORT_LIMIT_REACHED',
  /** It was closed or turned into a fine already (409, params.status). */
  PARKING_REPORT_CLOSED: 'PARKING_REPORT_CLOSED',
  // Emergencies and gate services (ADR 0047).
  /** Unknown, another compound's, or (where one in service is needed) retired. */
  PLACE_NOT_FOUND: 'PLACE_NOT_FOUND',
  /** Unknown, another compound's, or not the caller's to see. */
  EMERGENCY_NOT_FOUND: 'EMERGENCY_NOT_FOUND',
  /** Resolved or cancelled already (409, params.status). */
  EMERGENCY_CLOSED: 'EMERGENCY_CLOSED',
  /** The caller sees it but may not do this (403): cancel, or "on my way". */
  EMERGENCY_ACTION_NOT_ALLOWED: 'EMERGENCY_ACTION_NOT_ALLOWED',
  /** Another responder accepted it first (409). */
  EMERGENCY_ALREADY_ACCEPTED: 'EMERGENCY_ALREADY_ACCEPTED',
  /** Only its responder marks the arrival (403). */
  EMERGENCY_NOT_RESPONDER: 'EMERGENCY_NOT_RESPONDER',
  /** Nobody accepted it yet: there is no arrival to mark (409, params.status). */
  EMERGENCY_NOT_ON_THE_WAY: 'EMERGENCY_NOT_ON_THE_WAY',
  /** A guard never answers the SOS they raised themselves (403, ADR 0053). */
  EMERGENCY_OWN: 'EMERGENCY_OWN',
  /** Unknown, another compound's, or not the caller's to see. */
  GATE_SERVICE_NOT_FOUND: 'GATE_SERVICE_NOT_FOUND',
  /** Only someone who lives in the unit asks security for a service (403). */
  GATE_SERVICE_NOT_ALLOWED: 'GATE_SERVICE_NOT_ALLOWED',
  /**
   * The unit has params.max requests: open of this kind (params.scope
   * `open`), or made in the last 24 hours (`day`) (409).
   */
  GATE_SERVICE_LIMIT_REACHED: 'GATE_SERVICE_LIMIT_REACHED',
  /** It is not open any more: accepted, closed or cancelled (409, params.status). */
  GATE_SERVICE_NOT_OPEN: 'GATE_SERVICE_NOT_OPEN',
  /** Only the one who accepted it starts it (403). */
  GATE_SERVICE_NOT_HANDLER: 'GATE_SERVICE_NOT_HANDLER',
  /** Nobody accepted it yet, or it is over (409, params.status). */
  GATE_SERVICE_NOT_ACCEPTED: 'GATE_SERVICE_NOT_ACCEPTED',
  /** It is closed or cancelled already (409, params.status). */
  GATE_SERVICE_CLOSED: 'GATE_SERVICE_CLOSED',
  /** Unknown, another compound's, or not the caller's to see (ADR 0049). */
  PERMIT_NOT_FOUND: 'PERMIT_NOT_FOUND',
  /**
   * The caller may not ask for this permit (403): works, a move or a
   * material exit are the unit's primary's; an event needs the unit's
   * `visitorsInvite`.
   */
  PERMIT_NOT_ALLOWED: 'PERMIT_NOT_ALLOWED',
  /**
   * The unit (params.scope: `works`, `move`, `material_exit`, `event`) or
   * the permit (`workers`, `guests`) holds params.max already (409).
   */
  PERMIT_LIMIT_REACHED: 'PERMIT_LIMIT_REACHED',
  /** It is decided already (409, params.status). */
  PERMIT_NOT_PENDING: 'PERMIT_NOT_PENDING',
  /**
   * It is over, or not yet approved where that is needed: ended, rejected,
   * cancelled, revoked or used (409, params.status).
   */
  PERMIT_NOT_ACTIVE: 'PERMIT_NOT_ACTIVE',
  /** Unknown, or not of this permit (ADR 0049). */
  PERMIT_WORKER_NOT_FOUND: 'PERMIT_WORKER_NOT_FOUND',
  /** Unknown, or not of this event (ADR 0049). */
  PERMIT_GUEST_NOT_FOUND: 'PERMIT_GUEST_NOT_FOUND',
  /** The event has started: its guest list takes no one more (409). */
  PERMIT_STARTED: 'PERMIT_STARTED',
  /**
   * Too many wrong ID last-fours (429): the guard (params.scope `guard`, 5
   * in 15 minutes) or the worker (`worker`, 10 in a day) is locked out
   * until the window passes or the management unlocks them.
   */
  PERMIT_ID_LOCKED: 'PERMIT_ID_LOCKED',
  /**
   * The server holds no PAYMENT_CREDENTIALS_KEY, so no credential can be
   * stored and online payment cannot be turned on (503, ADR 0046).
   */
  PAYMENT_VAULT_UNAVAILABLE: 'PAYMENT_VAULT_UNAVAILABLE',
  /** Online payment needs the gateway's credentials first (409). */
  GATEWAY_NOT_CONFIGURED: 'GATEWAY_NOT_CONFIGURED',
  /** Unknown, another compound's, or not the caller's to see. */
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  /** Unknown, or another compound's. */
  INVOICE_BATCH_NOT_FOUND: 'INVOICE_BATCH_NOT_FOUND',
  /** The target holds no unit: an empty building (422). */
  INVOICE_BATCH_EMPTY: 'INVOICE_BATCH_EMPTY',
  /** More units than one issue takes (422, params.max). */
  INVOICE_BATCH_TOO_LARGE: 'INVOICE_BATCH_TOO_LARGE',
  /**
   * A credit note above what credit notes may still take off the invoice:
   * its total less them (409, params.creditable and params.outstanding).
   * Beyond what it owes, a credit note releases paid money (ADR 0048).
   */
  CREDIT_EXCEEDS_CREDITABLE: 'CREDIT_EXCEEDS_CREDITABLE',
  /** Unknown, or another compound's. */
  BILLING_PLAN_NOT_FOUND: 'BILLING_PLAN_NOT_FOUND',
  /** The unit has no terms of its own in the plan. */
  BILLING_OVERRIDE_NOT_FOUND: 'BILLING_OVERRIDE_NOT_FOUND',
  /** Unknown, another compound's, not a payment, or not the caller's to see. */
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /**
   * An online payment is never reversed (409): credit its invoice to
   * release the money to the unit's credit, then refund it (ADR 0048).
   */
  PAYMENT_NOT_REVERSIBLE: 'PAYMENT_NOT_REVERSIBLE',
  /** It was reversed already (409). */
  PAYMENT_ALREADY_REVERSED: 'PAYMENT_ALREADY_REVERSED',
  /**
   * More than the invoices still ask for: the office never takes credit
   * (409, params.outstanding).
   */
  PAYMENT_EXCEEDS_OUTSTANDING: 'PAYMENT_EXCEEDS_OUTSTANDING',
  /** Not the unit's, or nothing is owed on it (409, params.invoiceIds). */
  INVOICE_NOT_PAYABLE: 'INVOICE_NOT_PAYABLE',
  /** The unit owes nothing to pay online (409). */
  NOTHING_TO_PAY: 'NOTHING_TO_PAY',
  /**
   * The compound takes no online payment now: not configured, switched off
   * by its manager or the platform, or the server holds no key (409).
   */
  ONLINE_PAYMENT_UNAVAILABLE: 'ONLINE_PAYMENT_UNAVAILABLE',
  /** Another checkout of the unit is being opened right now (409; retry shortly). */
  PAYMENT_SESSION_IN_FLIGHT: 'PAYMENT_SESSION_IN_FLIGHT',
  /** Paymob could not open the checkout (502, params.reason); try again. */
  PAYMENT_GATEWAY_ERROR: 'PAYMENT_GATEWAY_ERROR',
  /** Unknown, another compound's, or not the caller's to see. */
  PAYMENT_SESSION_NOT_FOUND: 'PAYMENT_SESSION_NOT_FOUND',
  /** No receipt has this code (also a malformed code: no read is made). */
  RECEIPT_NOT_FOUND: 'RECEIPT_NOT_FOUND',
  /** Unknown, another compound's, or not the caller's to see. */
  INSTALMENT_PLAN_NOT_FOUND: 'INSTALMENT_PLAN_NOT_FOUND',
  /**
   * The invoice cannot become instalments (409, params.reason): it is an
   * instalment itself (`instalment`), already has a plan (`has_plan`), or
   * nothing is owed on it (`nothing_owed`).
   */
  INVOICE_NOT_CONVERTIBLE: 'INVOICE_NOT_CONVERTIBLE',
  /**
   * The instalments do not add up to what the invoice owes now — a payment
   * may have landed meanwhile (409, params.outstanding).
   */
  INSTALMENTS_DONT_ADD_UP: 'INSTALMENTS_DONT_ADD_UP',
  /** The plan was cancelled or is settled (409, params.status). */
  INSTALMENT_PLAN_CLOSED: 'INSTALMENT_PLAN_CLOSED',
  /**
   * The invoice is under an open dispute, so it is frozen: it cannot be
   * paid by name, credited, split, or its plan cancelled until the staff
   * decide (409, params.invoiceIds when a payment named it).
   */
  INVOICE_DISPUTED: 'INVOICE_DISPUTED',
  /** Nothing is owed on it: a paid invoice is not disputed (409). */
  INVOICE_NOT_DISPUTABLE: 'INVOICE_NOT_DISPUTABLE',
  /** Unknown, another compound's, or not the caller's to see. */
  DISPUTE_NOT_FOUND: 'DISPUTE_NOT_FOUND',
  /** The invoice has an open dispute already (409). */
  DISPUTE_ALREADY_OPEN: 'DISPUTE_ALREADY_OPEN',
  /** It was decided already (409, params.status). */
  DISPUTE_ALREADY_DECIDED: 'DISPUTE_ALREADY_DECIDED',
  /** The invoice was disputed params.max times already (409). */
  DISPUTE_LIMIT_REACHED: 'DISPUTE_LIMIT_REACHED',
  /** Unknown, another compound's, or not a refund. */
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  /** More than the unit's credit now (409, params.credit). */
  REFUND_EXCEEDS_CREDIT: 'REFUND_EXCEEDS_CREDIT',
  /** It was reversed already (409). */
  REFUND_ALREADY_REVERSED: 'REFUND_ALREADY_REVERSED',
  /** Money of this payment was refunded: it cannot be reversed (409). */
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  /** More rows than one export holds (422, params.max): narrow the period. */
  EXPORT_TOO_LARGE: 'EXPORT_TOO_LARGE',
  // guard shifts and tasks (ADR 0050)
  /**
   * The guard is scheduled then already (409, params.startsAt and
   * params.endsAt of the clash: a slot, or a template's slot to come).
   */
  ROSTER_OVERLAP: 'ROSTER_OVERLAP',
  /** Unknown, or another compound's. */
  ROSTER_TEMPLATE_NOT_FOUND: 'ROSTER_TEMPLATE_NOT_FOUND',
  /** It was ended already (409). */
  ROSTER_TEMPLATE_ENDED: 'ROSTER_TEMPLATE_ENDED',
  /** Unknown, another compound's, or not the caller's to see. */
  ROSTER_SLOT_NOT_FOUND: 'ROSTER_SLOT_NOT_FOUND',
  /** A shift filled it, or it was cancelled (409, params.status: `filled`, `cancelled`). */
  ROSTER_SLOT_CLOSED: 'ROSTER_SLOT_CLOSED',
  /**
   * Every active item of the handover checklist must be ticked (422,
   * params.missing: their ids).
   */
  HANDOVER_CHECKLIST_INCOMPLETE: 'HANDOVER_CHECKLIST_INCOMPLETE',
  /** The checklist has params.max active items already (409). */
  HANDOVER_CHECKLIST_FULL: 'HANDOVER_CHECKLIST_FULL',
  /** Unknown, or another compound's. */
  HANDOVER_ITEM_NOT_FOUND: 'HANDOVER_ITEM_NOT_FOUND',
  /** Unknown, another compound's, or not at the caller's post. */
  HANDOVER_NOT_FOUND: 'HANDOVER_NOT_FOUND',
  /** A guard does not acknowledge their own handover (403). */
  HANDOVER_OWN: 'HANDOVER_OWN',
  /** Someone acknowledged it already (409). */
  HANDOVER_ALREADY_ACKNOWLEDGED: 'HANDOVER_ALREADY_ACKNOWLEDGED',
  /** Unknown, another compound's, or not the caller's to see. */
  GUARD_TASK_NOT_FOUND: 'GUARD_TASK_NOT_FOUND',
  /** Another guard took it first (409). */
  GUARD_TASK_ALREADY_TAKEN: 'GUARD_TASK_ALREADY_TAKEN',
  /** Only the guard who took it completes it (403). */
  GUARD_TASK_NOT_TAKER: 'GUARD_TASK_NOT_TAKER',
  /** It is done or cancelled, or not in progress yet (409, params.status). */
  GUARD_TASK_CLOSED: 'GUARD_TASK_CLOSED',
  /** Unknown, another compound's, or not the caller's to see. */
  SWAP_NOT_FOUND: 'SWAP_NOT_FOUND',
  /** One of its slots is in another swap already (409). */
  SWAP_SLOT_BUSY: 'SWAP_SLOT_BUSY',
  /** It is not at that step any more (409, params.status). */
  SWAP_CLOSED: 'SWAP_CLOSED',
  /**
   * Its slots no longer allow it (409, params.reason: `slot_changed`, a slot
   * filled, cancelled or given to someone else; `started`; `guard_not_eligible`).
   */
  SWAP_NOT_POSSIBLE: 'SWAP_NOT_POSSIBLE',
  /** Only the colleague answers, only the requester withdraws, and nobody decides their own (403). */
  SWAP_ACTION_NOT_ALLOWED: 'SWAP_ACTION_NOT_ALLOWED',
  /** Unknown, another compound's, or one that does not reach the caller. */
  GUARD_INSTRUCTION_NOT_FOUND: 'GUARD_INSTRUCTION_NOT_FOUND',
  /** It was archived already (409). */
  GUARD_INSTRUCTION_ARCHIVED: 'GUARD_INSTRUCTION_ARCHIVED',
  /** Unknown, or another compound's. */
  FOUND_ITEM_NOT_FOUND: 'FOUND_ITEM_NOT_FOUND',
  /** It is not where this happens any more (409, params.status). */
  FOUND_ITEM_CLOSED: 'FOUND_ITEM_CLOSED',
  // governance (ADR 0051)
  /**
   * The caller owns no unit now (404): the board, its polls and elections
   * are the owners', and a tenant or a household member finds nothing.
   */
  GOVERNANCE_NOT_AVAILABLE: 'GOVERNANCE_NOT_AVAILABLE',
  /** Unknown, another compound's, or an ended seat where a seat is needed. */
  BOARD_MEMBER_NOT_FOUND: 'BOARD_MEMBER_NOT_FOUND',
  /** A board sits now (409): it is not appointed over (params.endsAt). */
  BOARD_SITTING: 'BOARD_SITTING',
  /** No board sits now (409): appoint one, or certify an election. */
  BOARD_NOT_SITTING: 'BOARD_NOT_SITTING',
  /** The board's seats are all taken (409, params.seats). */
  BOARD_SEATS_FULL: 'BOARD_SEATS_FULL',
  /** Another seated member holds this office (409, params.role). */
  BOARD_OFFICE_TAKEN: 'BOARD_OFFICE_TAKEN',
  /** The account sits on the board already (409). */
  BOARD_ALREADY_SEATED: 'BOARD_ALREADY_SEATED',
  /**
   * Only a sitting board member or the manager does this (403); a seat
   * that ended a moment ago counts as none.
   */
  BOARD_SEAT_REQUIRED: 'BOARD_SEAT_REQUIRED',
  /** Unknown, another compound's, or not the caller's to see (ADR 0051). */
  GOVERNANCE_POLL_NOT_FOUND: 'GOVERNANCE_POLL_NOT_FOUND',
  /** It opened already: only a cancel now (409, params.status). */
  GOVERNANCE_CONTEST_STARTED: 'GOVERNANCE_CONTEST_STARTED',
  /** It takes no vote now: not yet open, closed or cancelled (409, params.status). */
  GOVERNANCE_CONTEST_NOT_OPEN: 'GOVERNANCE_CONTEST_NOT_OPEN',
  /** It closed or was cancelled already (409, params.status). */
  GOVERNANCE_CONTEST_ENDED: 'GOVERNANCE_CONTEST_ENDED',
  /**
   * The caller does not cast this unit's vote in this poll or election
   * (403): the unit's voting owner when it opened does.
   */
  GOVERNANCE_NOT_ELECTOR: 'GOVERNANCE_NOT_ELECTOR',
  /** The unit voted already; a vote is never changed (409). */
  GOVERNANCE_ALREADY_VOTED: 'GOVERNANCE_ALREADY_VOTED',
  /** The compound has params.max polls and elections not yet ended (409). */
  GOVERNANCE_LIMIT_REACHED: 'GOVERNANCE_LIMIT_REACHED',
  /** Unknown, another compound's, or not the caller's to see (ADR 0051). */
  GOVERNANCE_ELECTION_NOT_FOUND: 'GOVERNANCE_ELECTION_NOT_FOUND',
  /** Unknown, or not of this election. */
  GOVERNANCE_CANDIDATE_NOT_FOUND: 'GOVERNANCE_CANDIDATE_NOT_FOUND',
  /** Nominations are not open now (409, params.phase). */
  GOVERNANCE_NOMINATIONS_CLOSED: 'GOVERNANCE_NOMINATIONS_CLOSED',
  /** Only an owner of a unit stands (403). */
  GOVERNANCE_CANDIDACY_NOT_ALLOWED: 'GOVERNANCE_CANDIDACY_NOT_ALLOWED',
  /** The caller stands already (409). */
  GOVERNANCE_ALREADY_CANDIDATE: 'GOVERNANCE_ALREADY_CANDIDATE',
  /**
   * Not counted yet: voting is still open, or its count not written yet
   * (409, params.phase). Retry once the close ran.
   */
  GOVERNANCE_NOT_CERTIFIABLE: 'GOVERNANCE_NOT_CERTIFIABLE',
  /** Unknown, another compound's, or archived where it must not be. */
  BOARD_PUBLICATION_NOT_FOUND: 'BOARD_PUBLICATION_NOT_FOUND',
  // patrols (ADR 0052)
  /** Unknown, or another compound's. */
  PATROL_CHECKPOINT_NOT_FOUND: 'PATROL_CHECKPOINT_NOT_FOUND',
  /** It was retired: nothing changes any more (409). */
  PATROL_CHECKPOINT_RETIRED: 'PATROL_CHECKPOINT_RETIRED',
  /** A route in service walks it (409, params.routes: how many). */
  PATROL_CHECKPOINT_IN_USE: 'PATROL_CHECKPOINT_IN_USE',
  /** Unknown, another compound's, or not the caller's to see. */
  PATROL_ROUTE_NOT_FOUND: 'PATROL_ROUTE_NOT_FOUND',
  /** It was retired: nothing changes any more (409). */
  PATROL_ROUTE_RETIRED: 'PATROL_ROUTE_RETIRED',
  /** Unknown, another compound's, or not the caller's to see. */
  PATROL_RUN_NOT_FOUND: 'PATROL_RUN_NOT_FOUND',
  /** Another guard started it first (409). */
  PATROL_ALREADY_STARTED: 'PATROL_ALREADY_STARTED',
  /**
   * Not now (409, params.reason: `too_early`, more than 15 minutes before
   * its start; `window_closed`; `missed`; `cancelled`).
   */
  PATROL_RUN_NOT_STARTABLE: 'PATROL_RUN_NOT_STARTABLE',
  /** Another run of the guard's is under way: one at a time (409). */
  PATROL_RUN_ALREADY_LIVE: 'PATROL_RUN_ALREADY_LIVE',
  /** The run is not under way (409, params.status). */
  PATROL_RUN_NOT_LIVE: 'PATROL_RUN_NOT_LIVE',
  /** Nobody may cancel it any more: it is not scheduled (409, params.status). */
  PATROL_RUN_CLOSED: 'PATROL_RUN_CLOSED',
  /**
   * Not a checkpoint of this compound in service, or not its current QR:
   * one answer for a malformed payload, an unknown or retired checkpoint,
   * another compound's, and an old printout (422).
   */
  PATROL_CHECKPOINT_INVALID: 'PATROL_CHECKPOINT_INVALID',
  /** The checkpoint is not on the run's route (422). */
  PATROL_CHECKPOINT_NOT_ON_ROUTE: 'PATROL_CHECKPOINT_NOT_ON_ROUTE',
  /** An ordered route expects another checkpoint first (422, params.expected: its position). */
  PATROL_OUT_OF_ORDER: 'PATROL_OUT_OF_ORDER',
  /** This run scanned that checkpoint already (409). */
  PATROL_CHECKPOINT_ALREADY_SCANNED: 'PATROL_CHECKPOINT_ALREADY_SCANNED',
  /**
   * The device's time is outside the run's lifetime, two minutes either
   * side (422).
   */
  PATROL_SCAN_OUT_OF_WINDOW: 'PATROL_SCAN_OUT_OF_WINDOW',
  /** That scan has its note already (409). */
  PATROL_NOTE_EXISTS: 'PATROL_NOTE_EXISTS',
  /**
   * The gate is locked down (ADR 0053): nobody but a resident comes in (409,
   * params.scope: gate or all).
   */
  LOCKDOWN_ACTIVE: 'LOCKDOWN_ACTIVE',
  /** Unknown, or another compound's lockdown. */
  LOCKDOWN_NOT_FOUND: 'LOCKDOWN_NOT_FOUND',
  /** The lockdown was ended already (409). */
  LOCKDOWN_ENDED: 'LOCKDOWN_ENDED',
  /**
   * No lockdown holds the gate of your shift: there is nothing to override
   * (409).
   */
  LOCKDOWN_NOT_AT_GATE: 'LOCKDOWN_NOT_AT_GATE',
  /** Unknown, or another compound's blocklist entry. */
  BLOCKLIST_ENTRY_NOT_FOUND: 'BLOCKLIST_ENTRY_NOT_FOUND',
  /** The entry was lifted already: it changes no more (409). */
  BLOCKLIST_ENTRY_LIFTED: 'BLOCKLIST_ENTRY_LIFTED',
  /**
   * Security does not let them in (409, ADR 0053). Never says why: the guard
   * reads the blocklist.
   */
  ENTRY_BLOCKED: 'ENTRY_BLOCKED',
  /** The permit's work is stopped already (409). */
  PERMIT_WORK_STOPPED: 'PERMIT_WORK_STOPPED',
  /** The permit's work is not stopped: there is nothing to resume (409). */
  PERMIT_WORK_NOT_STOPPED: 'PERMIT_WORK_NOT_STOPPED',
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
  /** Not an active category of this compound (ADR 0038). */
  CATEGORY_NOT_AVAILABLE: 'CATEGORY_NOT_AVAILABLE',
  /** Unknown, or holds no `tickets` capability where the ticket is. */
  REPORTER_NOT_ELIGIBLE: 'REPORTER_NOT_ELIGIBLE',
  /** Visiting hours shorter than one slot; params.min is the earliest end (ADR 0038). */
  VISIT_HOURS_TOO_SHORT: 'VISIT_HOURS_TOO_SHORT',
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
  /** Not inside the compound's visiting hours, on one day (ADR 0038). */
  VISIT_OUTSIDE_HOURS: 'VISIT_OUTSIDE_HOURS',
  /**
   * A receiver is an adult who lives in the unit, or an active domestic
   * worker of the unit.
   */
  RECEIVER_NOT_ELIGIBLE: 'RECEIVER_NOT_ELIGIBLE',
  // wages (ADR 0037)
  /** A month after the compound's current one. */
  WAGE_PERIOD_IN_FUTURE: 'WAGE_PERIOD_IN_FUTURE',
  /** A month before the engagement's first; params.first. */
  WAGE_PERIOD_BEFORE_ENGAGEMENT: 'WAGE_PERIOD_BEFORE_ENGAGEMENT',
  // requests to the management (ADR 0039)
  /** Overlaps an earlier window of the same weekday; params.other is its index. */
  OFFICE_HOURS_OVERLAP: 'OFFICE_HOURS_OVERLAP',
  /** Not an active topic of this compound. */
  TOPIC_NOT_AVAILABLE: 'TOPIC_NOT_AVAILABLE',
  /** Not an active resident or family account of this compound. */
  AUTHOR_NOT_ELIGIBLE: 'AUTHOR_NOT_ELIGIBLE',
  /** Not an active account holding `requests.handle`. */
  ASSIGNEE_NOT_ELIGIBLE: 'ASSIGNEE_NOT_ELIGIBLE',
  /** Not the start of a slot the office hours offer. */
  APPOINTMENT_SLOT_NOT_OFFERED: 'APPOINTMENT_SLOT_NOT_OFFERED',
  /** An appointment starts at least an hour from now. */
  APPOINTMENT_TOO_SOON: 'APPOINTMENT_TOO_SOON',
  /** An appointment starts within thirty days. */
  APPOINTMENT_TOO_FAR: 'APPOINTMENT_TOO_FAR',
  // community life (ADR 0040)
  /** An end that is not after its start (works, an event, an expiry, a poll). */
  ENDS_BEFORE_START: 'ENDS_BEFORE_START',
  // neighbours (ADR 0042)
  /** No unit of the compound has this code. */
  UNIT_CODE_UNKNOWN: 'UNIT_CODE_UNKNOWN',
  /** A unit of the author's own: nobody complains about their own unit. */
  OWN_UNIT: 'OWN_UNIT',
  /** Not an active resident or family account of the compound. */
  RECIPIENT_NOT_ELIGIBLE: 'RECIPIENT_NOT_ELIGIBLE',
  // facilities and bookings, the club (ADR 0044)
  /** Overlaps an earlier window of the same weekday; params.other is its index. */
  WINDOW_OVERLAP: 'WINDOW_OVERLAP',
  /** A peak time outside the facility's opening hours. */
  PEAK_OUTSIDE_HOURS: 'PEAK_OUTSIDE_HOURS',
  /** More peak bookings than bookings in a week; params.max is the weekly quota. */
  PEAK_QUOTA_ABOVE_WEEKLY: 'PEAK_QUOTA_ABOVE_WEEKLY',
  /** Not the start of one of the facility's slots. */
  BOOKING_SLOT_NOT_OFFERED: 'BOOKING_SLOT_NOT_OFFERED',
  /** A booking starts at least params.minutes from now. */
  BOOKING_TOO_SOON: 'BOOKING_TOO_SOON',
  /** A booking is at most params.days local days ahead. */
  BOOKING_TOO_FAR: 'BOOKING_TOO_FAR',
  /** More guests than the facility takes; params.max. */
  BOOKING_TOO_MANY_GUESTS: 'BOOKING_TOO_MANY_GUESTS',
  /** The booker and guests are more people than a slot takes; params.max guests. */
  BOOKING_PARTY_TOO_LARGE: 'BOOKING_PARTY_TOO_LARGE',
  /** A closure lasts at most params.days days. */
  CLOSURE_TOO_LONG: 'CLOSURE_TOO_LONG',
  /** A closure that has already ended. */
  CLOSURE_ENDED: 'CLOSURE_ENDED',
  /** Not an active plan of the club. */
  PLAN_NOT_AVAILABLE: 'PLAN_NOT_AVAILABLE',
  /** Paid in the future, or longer ago than params.min. */
  PAID_ON_OUT_OF_RANGE: 'PAID_ON_OUT_OF_RANGE',
  /** Not one of the unit's residing occupancies or household members now. */
  PERSON_NOT_OF_UNIT: 'PERSON_NOT_OF_UNIT',
  // vehicles and parking (ADR 0045)
  /** A permit's last day is after today and at most params.max (a local day). */
  PERMIT_DATE_OUT_OF_RANGE: 'PERMIT_DATE_OUT_OF_RANGE',
  /** Not an active visitor area of the compound. */
  AREA_NOT_AVAILABLE: 'AREA_NOT_AVAILABLE',
  /**
   * Not an active pass of the unit that the caller manages (its host or the
   * unit's primary): one answer for an unknown pass too.
   */
  PASS_NOT_AVAILABLE: 'PASS_NOT_AVAILABLE',
  /** A visitor parking booking starts no earlier than params.minutes ago. */
  PARKING_TOO_EARLY: 'PARKING_TOO_EARLY',
  /** It starts at most params.days ahead. */
  PARKING_TOO_FAR: 'PARKING_TOO_FAR',
  /** It lasts at least params.minutes. */
  PARKING_TOO_SHORT: 'PARKING_TOO_SHORT',
  /** It lasts at most params.hours (the compound's setting). */
  PARKING_TOO_LONG: 'PARKING_TOO_LONG',
  /** Its window is not inside the pass's (params.validFrom, params.validUntil). */
  PARKING_OUTSIDE_PASS: 'PARKING_OUTSIDE_PASS',
  /** Not a vehicle of that unit, or removed. */
  VEHICLE_NOT_OF_UNIT: 'VEHICLE_NOT_OF_UNIT',
  /** A local day outside params.min and params.max. */
  DAY_OUT_OF_RANGE: 'DAY_OUT_OF_RANGE',
  /** Not the fine's whole amount (params.amount): no partial payment. */
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** A sandbox key in live mode, or a live key in sandbox (ADR 0046). */
  GATEWAY_MODE_MISMATCH: 'GATEWAY_MODE_MISMATCH',
  /** Before today, or more than params.max days ahead. */
  DUE_ON_OUT_OF_RANGE: 'DUE_ON_OUT_OF_RANGE',
  /** The lines add up to more than an invoice may ask (params.max). */
  INVOICE_TOTAL_TOO_LARGE: 'INVOICE_TOTAL_TOO_LARGE',
  /** Before this month, or more than a year ahead (params.min, params.max). */
  STARTS_ON_OUT_OF_RANGE: 'STARTS_ON_OUT_OF_RANGE',
  /** Each instalment must fall due after the one before it. */
  DUE_DATES_NOT_INCREASING: 'DUE_DATES_NOT_INCREASING',
  /** Not between params.min and params.max (local days). */
  REFUNDED_ON_OUT_OF_RANGE: 'REFUNDED_ON_OUT_OF_RANGE',
  /** A period longer than params.maxDays days. */
  PERIOD_TOO_LONG: 'PERIOD_TOO_LONG',
  // permits (ADR 0049)
  /** Outside the compound's work hours, params.from to params.to (HH:mm). */
  OUTSIDE_WORK_HOURS: 'OUTSIDE_WORK_HOURS',
  /** A day the compound allows no works or moves on (none in a period). */
  NOT_A_WORK_DAY: 'NOT_A_WORK_DAY',
  /** A window longer than params.maxHours hours. */
  WINDOW_TOO_LONG: 'WINDOW_TOO_LONG',
  // guard shifts and tasks (ADR 0050)
  /** Not an active account holding `gate.operate`. */
  GUARD_NOT_ELIGIBLE: 'GUARD_NOT_ELIGIBLE',
  /** Not a gate or a zone in service. */
  POST_NOT_AVAILABLE: 'POST_NOT_AVAILABLE',
  /** The unit is not in closed mode (ADR 0020): nothing to inspect. */
  UNIT_NOT_CLOSED: 'UNIT_NOT_CLOSED',
  /**
   * Not a slot that may be swapped: the guard's own (or the colleague's),
   * scheduled, unopened and to come.
   */
  SLOT_NOT_SWAPPABLE: 'SLOT_NOT_SWAPPABLE',
  // governance (ADR 0051)
  /** Not an active account that owns a unit of the compound now. */
  OWNER_NOT_ELIGIBLE: 'OWNER_NOT_ELIGIBLE',
  /** A board of params.min to params.max seats. */
  BOARD_SIZE: 'BOARD_SIZE',
  // patrols (ADR 0052)
  /**
   * Two start times closer than a run's window (params.minutes), on a day,
   * over midnight or from Saturday into Sunday.
   */
  PATROL_SCHEDULE_OVERLAP: 'PATROL_SCHEDULE_OVERLAP',
  /** Not a checkpoint in service of this compound. */
  CHECKPOINT_NOT_AVAILABLE: 'CHECKPOINT_NOT_AVAILABLE',
} as const;

export type FieldErrorCode =
  (typeof FieldErrorCode)[keyof typeof FieldErrorCode];

export type ErrorParams = Record<
  string,
  string | number | boolean | string[] | number[]
>;

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
  badGateway: (code: ErrorCode, message: string, extra?: Extra) =>
    new AppException(HttpStatus.BAD_GATEWAY, code, message, extra),
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
