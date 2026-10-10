'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { personName, PriorityBadge, SlaBadges, ticketPlace } from '@/components/maintenance/sla';
import { TicketActions } from '@/components/maintenance/ticket-actions';
import { TicketThread } from '@/components/maintenance/ticket-thread';
import { TicketTrail } from '@/components/maintenance/ticket-trail';
import { TicketVisits } from '@/components/maintenance/ticket-visits';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TicketDetail } from '@/lib/queries';

const CLOCKS = [
  { name: 'Response', state: 'responseState', due: 'responseDueAt' },
  { name: 'Resolution', state: 'resolutionState', due: 'resolutionDueAt' },
] as const;

function Sla({ ticket }: { ticket: TicketDetail }) {
  const sla = ticket.sla;
  return (
    <Card flush>
      <CardHeader title="SLA" actions={<SlaBadges ticket={ticket} />} />
      <CardBody>
        {sla ? (
          <dl className="dl" style={{ gridTemplateColumns: 'max-content minmax(0, 1fr)' }}>
            {CLOCKS.map((c) => (
              <div key={c.name} style={{ display: 'contents' }}>
                <dt>{c.name}</dt>
                <dd>
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {sla[c.state] ? (
                      <Badge tone={sla[c.state] === 'breached' ? 'error' : sla[c.state] === 'met' ? 'green' : 'beige'}>
                        {humanize(sla[c.state])}
                      </Badge>
                    ) : (
                      <span className="t-secondary">Not started</span>
                    )}
                    {sla[c.due] ? <span className="t-secondary">due {formatDateTime(sla[c.due])}</span> : null}
                  </span>
                </dd>
              </div>
            ))}
            {ticket.escalatedAt ? (
              <>
                <dt>Escalated</dt>
                <dd>{formatDateTime(ticket.escalatedAt)}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="t-secondary">The compound is not measuring an SLA for this ticket.</p>
        )}
        {ticket.escalations.length ? (
          <ul className="list" style={{ marginTop: 12 }}>
            {ticket.escalations.map((e) => (
              <li key={`${e.slaCycle}-${e.at}`} className="list__item" style={{ paddingInline: 0 }}>
                <span className="list__text">
                  <span className="list__title" style={{ display: 'block' }}>
                    Escalated by {personName(e.by)}
                  </span>
                  <span className="list__meta">
                    {formatDateTime(e.at)} · SLA cycle {e.slaCycle}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Stars({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null;
  return (
    <span className="row" style={{ gap: 4 }} title={`${label}: ${value} of 5`}>
      <Star size={14} aria-hidden />
      <span className="t-num">{value}</span>
      <span className="t-secondary">{label}</span>
    </span>
  );
}

/** What the reporter said at each confirmation, rejection or reopen (ADR 0038). */
function Feedback({ ticket }: { ticket: TicketDetail }) {
  if (!ticket.feedback.length) return null;
  return (
    <Card flush>
      <CardHeader title="Reporter's feedback" />
      <ul className="list">
        {ticket.feedback.map((f) => (
          <li key={`${f.cycle}-${f.createdAt}`} className="list__item" style={{ alignItems: 'flex-start' }}>
            <span className="list__text">
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Badge tone={f.kind === 'confirmed' ? 'green' : 'terracotta'}>{humanize(f.kind)}</Badge>
                <Stars value={f.rating} label="the work" />
                <Stars value={f.technicianRating} label={f.ratedTechnician ? personName(f.ratedTechnician) : 'the technician'} />
                {f.reasonCode ? <span className="t-secondary">{humanize(f.reasonCode)}</span> : null}
              </span>
              {f.comment ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{f.comment}</p> : null}
              <span className="list__meta">
                {personName(f.author)} · {formatDateTime(f.createdAt)}
                {f.cycle > 1 ? ` · cycle ${f.cycle}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Details({ ticket }: { ticket: TicketDetail }) {
  const { can } = usePermissions();
  const reports = ticket.photos.filter((p) => p.url);
  return (
    <Card flush>
      <CardHeader title="Ticket" />
      <CardBody>
        <dl className="dl">
          <dt>Where</dt>
          <dd>
            {ticket.unit && can('units.read') ? (
              <Link className="table__link" href={`/units/${ticket.unit.id}`}>
                {ticketPlace(ticket)}
              </Link>
            ) : (
              ticketPlace(ticket)
            )}
          </dd>
          <dt>Category</dt>
          <dd>
            {ticket.category.nameEn}
            {ticket.preventiveService ? ` · ${ticket.preventiveService.nameEn}` : ''}
            {ticket.kind === 'preventive' ? ' (preventive check-up)' : ''}
          </dd>
          {ticket.requestedStartsAt ? (
            <>
              <dt>Requested window</dt>
              <dd>
                {formatDateTime(ticket.requestedStartsAt)} to {formatDateTime(ticket.requestedEndsAt).slice(-5)}
              </dd>
            </>
          ) : null}
          <dt>Reported by</dt>
          <dd>
            {personName(ticket.reporter)}
            {ticket.createdBy.id !== ticket.reporter.id ? (
              <span className="t-secondary"> · opened for them by {personName(ticket.createdBy)}</span>
            ) : null}
          </dd>
          <dt>Technician</dt>
          <dd>{ticket.technician ? personName(ticket.technician) : <span className="t-secondary">Unassigned</span>}</dd>
          <dt>Opened</dt>
          <dd>{formatDateTime(ticket.createdAt)}</dd>
          {ticket.completedAt ? (
            <>
              <dt>Work reported done</dt>
              <dd>
                {formatDateTime(ticket.completedAt)}
                {ticket.confirmationStatus ? (
                  <span className="t-secondary"> · {humanize(ticket.confirmationStatus).toLowerCase()} by the reporter</span>
                ) : null}
              </dd>
            </>
          ) : null}
          {ticket.closedAt ? (
            <>
              <dt>Closed</dt>
              <dd>{formatDateTime(ticket.closedAt)}</dd>
            </>
          ) : null}
          {ticket.cancelledAt ? (
            <>
              <dt>Cancelled</dt>
              <dd>{formatDateTime(ticket.cancelledAt)}</dd>
            </>
          ) : null}
          {ticket.cycle > 1 || ticket.rejectionCount > 0 ? (
            <>
              <dt>Rounds</dt>
              <dd>
                Cycle {ticket.cycle}
                {ticket.rejectionCount > 0 ? ` · rejected ${ticket.rejectionCount} time${ticket.rejectionCount === 1 ? '' : 's'}` : ''}
              </dd>
            </>
          ) : null}
          <dt>Description</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{ticket.description || '—'}</dd>
        </dl>
        {ticket.photos.length ? (
          <div className="stack stack--sm" style={{ marginTop: 16 }}>
            <span className="t-secondary">
              Photos ({ticket.photos.length}): {['report', 'before', 'after'].filter((k) => ticket.photos.some((p) => p.kind === k)).join(', ')}
            </span>
            <div className="photo-grid">
              {reports.map((p) => (
                // Short-lived presigned links: opened in a new tab, never stored.
                <a key={p.id} href={p.url ?? '#'} target="_blank" rel="noreferrer" title={`${humanize(p.kind)} photo`}>
                  <img src={p.url ?? ''} alt={`${humanize(p.kind)} photo`} loading="lazy" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
            {reports.length < ticket.photos.length ? (
              <span className="t-secondary">Some photos are no longer available.</span>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const ticket = useQuery({ queryKey: keys.ticket(id), queryFn: () => fetchers.ticket(id), refetchInterval: 60_000 });
  const t = ticket.data;

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/maintenance" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Maintenance
          </ButtonLink>
        }
        title={
          t ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {t.number}
              <StatusBadge status={t.status} />
              {t.holdReason ? <Badge tone="terracotta">{humanize(t.holdReason)}</Badge> : null}
              {t.priority !== 'normal' ? <PriorityBadge priority={t.priority} /> : null}
            </span>
          ) : (
            'Ticket'
          )
        }
        description={t ? `${ticketPlace(t)} · ${t.category.nameEn} · ${humanize(t.priority)} priority` : undefined}
        actions={t ? <TicketActions ticket={t} /> : undefined}
      />
      <QueryState query={ticket}>
        {t ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Details ticket={t} />
              <TicketThread ticketId={t.id} status={t.status} />
              <TicketVisits ticket={t} />
            </div>
            <div className="stack">
              <Sla ticket={t} />
              <Feedback ticket={t} />
              <TicketTrail ticketId={t.id} />
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
