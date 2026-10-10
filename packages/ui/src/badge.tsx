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
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="t-secondary">—</span>;
  const label = status.replace(/_/g, ' ');
  return <Badge tone={STATUS_TONE[status] ?? 'beige'}>{label.charAt(0).toUpperCase() + label.slice(1)}</Badge>;
}
