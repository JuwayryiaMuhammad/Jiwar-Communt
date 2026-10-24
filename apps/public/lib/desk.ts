/**
 * The partner's desk (ADR 0060): what a request lets the partner do now,
 * and the closed lists it answers with. Plain TypeScript, tested as is.
 */

export type DeskRequest = {
  id: string;
  number: string;
  category: string;
  subcategory: { nameEn: string; nameAr: string } | null;
  status: string;
  askedStartsAt: string;
  askedEndsAt: string;
  proposedStartsAt: string | null;
  proposedEndsAt: string | null;
  agreedStartsAt: string | null;
  agreedEndsAt: string | null;
  staffCount: number | null;
  gatePass: boolean;
  closedBy: string | null;
  closeReason: string | null;
  consentWithdrawn: boolean;
  unitCode: string | null;
  firstName: string | null;
  note: string | null;
  items: { nameEn: string; nameAr: string; price: string; unit: string; quantity: number }[];
  pass: { code: string | null; link: string | null; qrPayload: string | null; validFrom: string; validUntil: string; partySize: number } | null;
};

export type DeskView = {
  partner: { id: string; nameEn: string; nameAr: string };
  compoundName: string;
  timeZone: string;
  requests: DeskRequest[];
};

export type DeskAction = 'accept' | 'decline' | 'propose' | 'done' | 'cancel';

/** The partner's answers a request takes now, by its status; none without the consent. */
export function deskActions(r: Pick<DeskRequest, 'status' | 'consentWithdrawn'>): DeskAction[] {
  if (r.consentWithdrawn) return [];
  switch (r.status) {
    case 'pending':
      return ['accept', 'propose', 'decline'];
    case 'proposed':
      return ['decline'];
    case 'accepted':
      return ['done', 'cancel'];
    default:
      return [];
  }
}

/** The backend's closed lists (REASON_CODES.partnerRequestDecline and partnerRequestPartnerCancel). */
export const DECLINE_REASONS = ['unavailable', 'out_of_area', 'not_offered', 'other'] as const;
export const CANCEL_REASONS = ['unavailable', 'emergency', 'other'] as const;

/** A local `datetime-local` value as an ISO instant, or null. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Open requests first, by the window that counts for them, then the rest. */
export function deskOrder(requests: readonly DeskRequest[]): DeskRequest[] {
  const live = (r: DeskRequest) => ['pending', 'proposed', 'accepted'].includes(r.status);
  const at = (r: DeskRequest) => r.agreedStartsAt ?? r.proposedStartsAt ?? r.askedStartsAt;
  return [...requests].sort((a, b) => Number(live(b)) - Number(live(a)) || at(a).localeCompare(at(b)));
}
