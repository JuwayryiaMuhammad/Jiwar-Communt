import type { ReactNode } from 'react';

export type Tone = 'green' | 'beige' | 'terracotta' | 'error' | 'dark';

export function Badge({
  tone = 'beige',
  plain,
  children,
}: {
  tone?: Tone;
  plain?: boolean;
  children: ReactNode;
}) {
  return <span className={`badge badge--${tone}${plain ? ' badge--plain' : ''}`}>{children}</span>;
}

/**
 * Status words used across the API, mapped to the palette: green for the
 * healthy state, terracotta for "needs attention", error only for states
 * that block (the design keeps red for destructive and invalid states).
 */
const STATUS_TONE: Record<string, Tone> = {
  active: 'green',
  open: 'terracotta',
  pending: 'terracotta',
  pending_review: 'terracotta',
  inside: 'green',
  in: 'green',
  out: 'beige',
  closed: 'beige',
  ended: 'beige',
  inactive: 'beige',
  cancelled: 'beige',
  completed: 'beige',
  suspended: 'error',
  frozen: 'error',
  rejected: 'error',
  erased: 'dark',
  revoked: 'beige',
  // Maintenance tickets and visits (ADR 0032, 0034).
  new: 'terracotta',
  assigned: 'beige',
  en_route: 'green',
  in_progress: 'green',
  on_hold: 'terracotta',
  proposed: 'terracotta',
  confirmed: 'green',
  arrived: 'green',
  done: 'beige',
  no_access: 'error',
  rescheduled: 'beige',
  available: 'green',
  unavailable: 'beige',
  // Parcels (ADR 0035).
  held: 'terracotta',
  handed_over: 'green',
  returned: 'beige',
  // Requests to the management and their appointments (ADR 0039). `open`,
  // `in_progress`, `closed`, `proposed`, `confirmed` and `cancelled` are above.
  answered: 'green',
  requested: 'terracotta',
  superseded: 'beige',
  // Community life (ADR 0040). `ended`, `closed`, `cancelled`, `open` and
  // `done` are above.
  draft: 'beige',
  scheduled: 'terracotta',
  published: 'green',
  expired: 'beige',
  archived: 'beige',
  upcoming: 'terracotta',
  ongoing: 'green',
  received: 'terracotta',
  under_review: 'terracotta',
  planned: 'green',
  declined: 'error',
  // Neighbours (ADR 0042): complaints and claims. `under_review`, `open`,
  // `expired`, `closed`, `pending`, `handed_over` and `declined` are above.
  submitted: 'terracotta',
  notice_sent: 'beige',
  mediation: 'green',
  resolved: 'green',
  dismissed: 'beige',
  withdrawn: 'beige',
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="t-secondary">—</span>;
  const label = status.replace(/_/g, ' ');
  return <Badge tone={STATUS_TONE[status] ?? 'beige'}>{label.charAt(0).toUpperCase() + label.slice(1)}</Badge>;
}
