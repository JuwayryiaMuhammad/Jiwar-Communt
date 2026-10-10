import { formatDateTime, relativeTime } from '@jiwar/api';
import { Badge } from '@jiwar/ui';
import type { Ticket, TicketPriority } from '@/lib/queries';

/** A person in a ticket's views: a name, or what is left of an erased account. */
export function personName(p: { fullName?: string | null; erased?: boolean } | null | undefined): string {
  if (!p) return '—';
  return p.erased ? 'Erased account' : (p.fullName ?? '—');
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  if (priority === 'emergency') return <Badge tone="error">Emergency</Badge>;
  if (priority === 'urgent') return <Badge tone="terracotta">Urgent</Badge>;
  return <span className="t-secondary">Normal</span>;
}

/** The commitment that comes due first, while its clock runs. */
function nextDue(sla: NonNullable<Ticket['sla']>): { label: string; at: string } | null {
  const due = [
    sla.responseDueAt ? { label: 'Response', at: sla.responseDueAt } : null,
    sla.resolutionDueAt ? { label: 'Resolution', at: sla.resolutionDueAt } : null,
  ].filter((d): d is { label: string; at: string } => d !== null);
  return due.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
}

/**
 * A ticket's SLA at a glance, as the API says it: overdue (late and still
 * unmet), paused, or when the next commitment is due; and whether a resident
 * escalated it in this cycle. Nothing while the compound measures no SLA.
 */
export function SlaBadges({ ticket }: { ticket: Pick<Ticket, 'sla' | 'escalatedAt'> }) {
  const { sla, escalatedAt } = ticket;
  if (!sla && !escalatedAt) return <span className="t-secondary">—</span>;
  const due = sla ? nextDue(sla) : null;
  return (
    <span className="row" style={{ flexWrap: 'wrap', gap: 6, justifyContent: 'inherit' }}>
      {sla?.overdue ? <Badge tone="error">Overdue</Badge> : null}
      {sla?.paused ? <Badge tone="beige">Paused</Badge> : null}
      {sla && !sla.overdue && due ? (
        <span className="t-secondary" title={`${due.label} due ${formatDateTime(due.at)}`}>
          {due.label} {relativeTime(due.at)}
        </span>
      ) : null}
      {sla && !sla.overdue && !sla.paused && !due ? <span className="t-secondary">On time</span> : null}
      {escalatedAt ? (
        <span title={`Escalated by a resident ${formatDateTime(escalatedAt)}`}>
          <Badge tone="terracotta">Escalated</Badge>
        </span>
      ) : null}
    </span>
  );
}

/** Where the ticket is: the unit and room, or the common area. */
export function ticketPlace(t: Pick<Ticket, 'unit' | 'unitLocation' | 'commonArea'>): string {
  if (t.unit) return t.unitLocation ? `Unit ${t.unit.code} · ${t.unitLocation.replace(/_/g, ' ')}` : `Unit ${t.unit.code}`;
  return t.commonArea ? `Common area · ${t.commonArea}` : 'Common area';
}
