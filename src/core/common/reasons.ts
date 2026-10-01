import { appError, ErrorCode, FieldErrorCode, type FieldError } from './errors';

/**
 * A reason for a rejection, revocation, freeze or suspension (Phase 2.2).
 *
 * - `code` comes from a closed list per action. It goes into the audit
 *   metadata, where it can never name anyone (ADR 0014).
 * - `text` is what the person is told. It lives on the record and in the
 *   notice, both erasable — never in the immutable trail.
 */
export interface ReasonInput {
  code?: string;
  text?: string;
}

export interface Reason<C extends string = string> {
  code: C;
  text: string;
}

export const REASON_TEXT_MAX = 1000;

/**
 * Both parts are required (`REASON_REQUIRED`); a code outside `allowed` is a
 * field error `INVALID_REASON_CODE`.
 */
export function requireReasonCode<C extends string>(
  input: ReasonInput | undefined,
  allowed: readonly C[],
): Reason<C> {
  const code = (input?.code ?? '').trim();
  const text = (input?.text ?? '').trim();
  const missing: FieldError[] = [
    ...(code
      ? []
      : [{ field: 'reasonCode', code: FieldErrorCode.FIELD_REQUIRED }]),
    ...(text ? [] : [{ field: 'reason', code: FieldErrorCode.FIELD_REQUIRED }]),
  ];
  if (missing.length) {
    throw appError.badRequest(
      ErrorCode.REASON_REQUIRED,
      'A reason is required',
      {
        fields: missing,
      },
    );
  }
  if (!(allowed as readonly string[]).includes(code)) {
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Unknown reason code',
      {
        fields: [
          {
            field: 'reasonCode',
            code: FieldErrorCode.INVALID_REASON_CODE,
            params: { allowed: [...allowed] },
          },
        ],
      },
    );
  }
  if (text.length > REASON_TEXT_MAX) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Reason too long', {
      fields: [
        {
          field: 'reason',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { max: REASON_TEXT_MAX },
        },
      ],
    });
  }
  return { code: code as C, text };
}

/**
 * The closed lists, one per action. Adding a code is a reviewed change: the
 * audit trail keeps every code ever used, forever.
 */
export const REASON_CODES = {
  occupancyEnd: ['moved_out', 'contract_ended', 'data_correction', 'other'],
  memberRemoval: ['moved_out', 'relation_ended', 'misconduct', 'other'],
  memberRejection: ['not_verified', 'not_a_member', 'other'],
  workerSuspend: ['leave', 'absence', 'misconduct', 'other'],
  workerEnd: ['work_finished', 'moved', 'misconduct', 'other'],
  workerReject: ['documents_invalid', 'not_verified', 'other'],
  workerBan: ['security', 'misconduct', 'fraud', 'other'],
  reviewFlag: ['deceased', 'separation', 'other'],
  reviewClear: ['resolved', 'data_correction', 'other'],
  householdEnd: ['unit_changed_hands', 'household_left', 'other'],
  memberRemovalByManagement: ['separation', 'data_correction', 'other'],
  permissionRevoke: ['misuse', 'no_longer_needed', 'security', 'other'],
  deferredActionDecline: ['not_needed', 'too_expensive', 'other'],
  complianceReport: ['document_review', 'report_received', 'other'],
  complianceClose: ['resolved', 'unfounded', 'other'],
  accountFreeze: ['phone_reassigned'],
  registrationReject: [
    'not_a_resident',
    'unit_mismatch',
    'duplicate',
    'documents_missing',
    'other',
  ],
  legalHold: ['litigation', 'regulator_request', 'financial_audit', 'other'],
  legalHoldRelease: ['resolved', 'other'],
  cardReissue: ['lost', 'compromised', 'other'],
  // A code only, never text (ADR 0028).
  visitorPassCancel: ['not_needed', 'plans_changed', 'other'],
} as const;
