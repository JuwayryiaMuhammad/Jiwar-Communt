/**
 * The staff inbox's types (ADR 0073): what each is called, which page
 * decides it, and the permission that page opens with. The inbox decides
 * nothing itself; each row opens its own domain's page.
 */
export const INBOX_TYPE: Record<string, { label: string; href: (id: string) => string }> = {
  registration: { label: 'Registration', href: () => '/requests' },
  identity_change: { label: 'Name or phone change', href: () => '/identity-changes' },
  worker_engagement: { label: 'Household worker', href: () => '/workers' },
  vehicle: { label: 'Vehicle', href: () => '/vehicles' },
  booking: { label: 'Booking', href: () => '/bookings/approvals' },
  unit_permit: { label: 'Unit permit', href: (id) => `/permits/${id}` },
  work_permit: { label: 'Work permit', href: () => '/work-permits' },
  field_exception: { label: 'Field exception', href: () => '/security/field-exceptions' },
  plan_request: { label: 'Payment plan request', href: () => '/finance/plan-requests' },
  invoice_dispute: { label: 'Invoice dispute', href: () => '/finance/disputes' },
  decision_appeal: { label: 'Decision appeal', href: (id) => `/appeals/${id}` },
  management_request: { label: 'Management request', href: (id) => `/management-requests/${id}` },
  // ADR 0084.
  space_use_request: { label: 'Common-area use', href: () => '/space-uses' },
  // ADR 0081.
  plan_suggestion: { label: 'Plan suggestion', href: () => '/recurrence' },
};

export const inboxLabel = (type: string) => INBOX_TYPE[type]?.label ?? type;

/** How long something has waited: "3 h", "2 d". */
export function waited(since: string, now: number): string {
  const h = Math.max(0, Math.floor((now - new Date(since).getTime()) / 3_600_000));
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
