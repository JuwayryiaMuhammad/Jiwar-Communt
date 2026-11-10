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
  // ADR 0082.
  follow_up_case: { label: 'Follow-up case', href: (id) => `/experience/cases/${id}` },
  recovery_case: { label: 'Recovery case', href: (id) => `/experience/cases/${id}` },
  compensation: { label: 'Compensation', href: () => '/experience/compensations' },
  // ADR 0083.
  ownership_transfer: { label: 'Ownership transfer', href: () => '/ownership-transfers' },
  closed_unit_round: { label: 'Closed unit round', href: () => '/security/closed-units' },
  unit_entry_report: { label: 'Emergency entry report', href: () => '/security/unit-entries' },
  // ADR 0090.
  dangling_account: { label: 'Dangling account', href: () => '/access-checks' },
  access_review: { label: 'Access review', href: () => '/access-checks' },
  reinforcement_suggestion: { label: 'Reinforcement suggested', href: () => '/field-team?tab=reinforcement' },
  // ADR 0092.
  gl_manual_entry: { label: 'Journal entry', href: () => '/finance/gl/entries' },
};
