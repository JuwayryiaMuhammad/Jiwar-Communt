'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader, StatusBadge, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PriorityBadge, SlaBadges, useTicketWords } from '@/components/maintenance/sla';
import { TicketActions } from '@/components/maintenance/ticket-actions';
import { TicketStaffMoves } from '@/components/maintenance/ticket-staff-moves';
import { SensitiveReads, TicketSensitivity } from '@/components/maintenance/ticket-sensitivity';
import { TicketQuotes } from '@/components/maintenance/ticket-quotes';
import { TicketPermits } from '@/components/maintenance/ticket-permits';
import { TicketThread } from '@/components/maintenance/ticket-thread';
import { TicketTrail } from '@/components/maintenance/ticket-trail';
import { TicketVisits } from '@/components/maintenance/ticket-visits';
import { WorkOrder } from '@/components/maintenance/work-order';
import {
  TicketCompletion,
  TicketCosts,
  TicketParts,
  TicketQuoteSuggestions,
} from '@/components/maintenance/ticket-operations';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type TicketDetail } from '@/lib/queries';
import ar from '@/messages/ar/maint-ticket';
import en from '@/messages/en/maint-ticket';

const CLOCKS = [
  { name: 'response', state: 'responseState', due: 'responseDueAt' },
  { name: 'resolution', state: 'resolutionState', due: 'resolutionDueAt' },
] as const;
const PHOTO_KINDS = ['report', 'before', 'after'] as const;

function Sla({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const words = useTicketWords();
  const sla = ticket.sla;
  return (
    <Card flush>
      <CardHeader title={t('sla')} actions={<SlaBadges ticket={ticket} />} />
      <CardBody>
        {sla ? (
          <dl className="dl" style={{ gridTemplateColumns: 'max-content minmax(0, 1fr)' }}>
            {CLOCKS.map((c) => (
              <div key={c.name} style={{ display: 'contents' }}>
                <dt>{t(`clock.${c.name}`)}</dt>
                <dd>
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {sla[c.state] ? (
                      <Badge tone={sla[c.state] === 'breached' ? 'error' : sla[c.state] === 'met' ? 'green' : 'beige'}>
                        {label(sla[c.state])}
                      </Badge>
                    ) : (
                      <span className="t-secondary">{t('notStarted')}</span>
                    )}
                    {sla[c.due] ? <span className="t-secondary">{t('due', { when: fmt.dateTime(sla[c.due]) })}</span> : null}
                  </span>
                </dd>
              </div>
            ))}
            {ticket.escalatedAt ? (
              <>
                <dt>{t('escalated')}</dt>
                <dd>{fmt.dateTime(ticket.escalatedAt)}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="t-secondary">{t('noSla')}</p>
        )}
        {ticket.escalations.length ? (
          <ul className="list" style={{ marginTop: 12 }}>
            {ticket.escalations.map((e) => (
              <li key={`${e.slaCycle}-${e.at}`} className="list__item" style={{ paddingInline: 0 }}>
                <span className="list__text">
                  <span className="list__title" style={{ display: 'block' }}>
                    {t('escalatedBy', { name: words.person(e.by) })}
                  </span>
                  <span className="list__meta">{t('slaCycle', { when: fmt.dateTime(e.at), n: e.slaCycle })}</span>
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
  const t = useT(en, ar);
  if (value === null) return null;
  return (
    <span className="row" style={{ gap: 4 }} title={t('stars', { label, value })}>
      <Star size={14} aria-hidden />
      <span className="t-num">{value}</span>
      <span className="t-secondary">{label}</span>
    </span>
  );
}

/** What the reporter said at each confirmation, rejection or reopen (ADR 0038). */
function Feedback({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const words = useTicketWords();
  if (!ticket.feedback.length) return null;
  return (
    <Card flush>
      <CardHeader title={t('feedback')} />
      <ul className="list">
        {ticket.feedback.map((f) => (
          <li key={`${f.cycle}-${f.createdAt}`} className="list__item" style={{ alignItems: 'flex-start' }}>
            <span className="list__text">
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Badge tone={f.kind === 'confirmed' ? 'green' : 'terracotta'}>{label(f.kind)}</Badge>
                <Stars value={f.rating} label={t('theWork')} />
                <Stars value={f.technicianRating} label={f.ratedTechnician ? words.person(f.ratedTechnician) : t('theTechnician')} />
                {f.reasonCode ? <span className="t-secondary">{label(f.reasonCode)}</span> : null}
              </span>
              {f.comment ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{f.comment}</p> : null}
              <span className="list__meta">
                {words.person(f.author)} · {fmt.dateTime(f.createdAt)}
                {f.cycle > 1 ? <> · {t('cycle', { n: f.cycle })}</> : null}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Details({ ticket }: { ticket: TicketDetail }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const words = useTicketWords();
  const { can } = usePermissions();
  const reports = ticket.photos.filter((p) => p.url);
  const kinds = PHOTO_KINDS.filter((k) => ticket.photos.some((p) => p.kind === k)).map((k) => t(`photoKind.${k}`));
  return (
    <Card flush>
      <CardHeader title={t('ticket')} />
      <CardBody>
        <dl className="dl">
          <dt>{t('where')}</dt>
          <dd>
            {ticket.unit && can('units.read') ? (
              <Link className="table__link" href={`/units/${ticket.unit.id}`}>
                {words.place(ticket)}
              </Link>
            ) : (
              words.place(ticket)
            )}
          </dd>
          <dt>{t('category')}</dt>
          <dd>
            {ticket.category.nameEn}
            {ticket.preventiveService ? ` · ${ticket.preventiveService.nameEn}` : ''}
            {ticket.kind === 'preventive' ? <> {t('preventiveCheck')}</> : null}
          </dd>
          {ticket.requestedStartsAt ? (
            <>
              <dt>{t('requestedWindow')}</dt>
              <dd>{t('window', { from: fmt.dateTime(ticket.requestedStartsAt), to: fmt.time(ticket.requestedEndsAt) })}</dd>
            </>
          ) : null}
          <dt>{t('reportedBy')}</dt>
          <dd>
            {words.person(ticket.reporter)}
            {ticket.createdBy.id !== ticket.reporter.id ? (
              <span className="t-secondary"> · {t('openedFor', { name: words.person(ticket.createdBy) })}</span>
            ) : null}
          </dd>
          <dt>{t('technician')}</dt>
          <dd>{ticket.technician ? words.person(ticket.technician) : <span className="t-secondary">{t('unassigned')}</span>}</dd>
          <dt>{t('opened')}</dt>
          <dd>{fmt.dateTime(ticket.createdAt)}</dd>
          {ticket.completedAt ? (
            <>
              <dt>{t('workDone')}</dt>
              <dd>
                {fmt.dateTime(ticket.completedAt)}
                {ticket.confirmationStatus ? (
                  <span className="t-secondary"> · {t('confirmation', { status: ticket.confirmationStatus })}</span>
                ) : null}
              </dd>
            </>
          ) : null}
          {ticket.closedAt ? (
            <>
              <dt>{t('closed')}</dt>
              <dd>{fmt.dateTime(ticket.closedAt)}</dd>
            </>
          ) : null}
          {ticket.cancelledAt ? (
            <>
              <dt>{t('cancelled')}</dt>
              <dd>{fmt.dateTime(ticket.cancelledAt)}</dd>
            </>
          ) : null}
          {ticket.cycle > 1 || ticket.rejectionCount > 0 ? (
            <>
              <dt>{t('rounds')}</dt>
              <dd>
                {t('cycleN', { n: ticket.cycle })}
                {ticket.rejectionCount > 0 ? <> · {t('rejectedTimes', { n: ticket.rejectionCount })}</> : null}
              </dd>
            </>
          ) : null}
          <dt>{t('description')}</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{ticket.description || '—'}</dd>
        </dl>
        {ticket.photos.length ? (
          <div className="stack stack--sm" style={{ marginTop: 16 }}>
            <span className="t-secondary">{t('photos', { n: ticket.photos.length, kinds: fmt.list(kinds) })}</span>
            <div className="photo-grid">
              {reports.map((p) => (
                // Short-lived presigned links: opened in a new tab, never stored.
                <a key={p.id} href={p.url ?? '#'} target="_blank" rel="noreferrer" title={t('photoOf', { kind: p.kind })}>
                  <img src={p.url ?? ''} alt={t('photoOf', { kind: p.kind })} loading="lazy" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
            {reports.length < ticket.photos.length ? <span className="t-secondary">{t('photosGone')}</span> : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default function TicketPage() {
  const tr = useT(en, ar);
  const label = useLabel();
  const words = useTicketWords();
  const { id } = useParams<{ id: string }>();
  const ticket = useQuery({ queryKey: keys.ticket(id), queryFn: () => fetchers.ticket(id), refetchInterval: 60_000 });
  const t = ticket.data;

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/maintenance" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {tr('back')}
          </ButtonLink>
        }
        title={
          t ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {t.number}
              <StatusBadge status={t.status} />
              {t.holdReason ? <Badge tone="terracotta">{label(t.holdReason)}</Badge> : null}
              {t.priority !== 'normal' ? <PriorityBadge priority={t.priority} /> : null}
            </span>
          ) : (
            tr('ticket')
          )
        }
        description={
          t ? tr('headerDescription', { place: words.place(t), category: t.category.nameEn, priority: label(t.priority) }) : undefined
        }
        actions={
          t ? (
            <span className="row" style={{ gap: 6 }}>
              <TicketStaffMoves ticket={t} />
              <TicketSensitivity ticket={t} />
              <TicketActions ticket={t} />
            </span>
          ) : undefined
        }
      />
      <QueryState query={ticket}>
        {t ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <SensitiveReads ticket={t} />
              <Details ticket={t} />
              <WorkOrder ticket={t} />
              <TicketCompletion ticket={t} />
              <TicketThread ticketId={t.id} status={t.status} />
              <TicketQuoteSuggestions ticket={t} />
              <TicketPermits ticket={t} />
              <TicketQuotes ticket={t} />
              <TicketCosts ticket={t} />
              <TicketParts ticket={t} />
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
