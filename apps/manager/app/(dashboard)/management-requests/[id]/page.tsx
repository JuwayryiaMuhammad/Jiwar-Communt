'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { personName, ResponseBadges, TYPE_TEXT } from '@/components/management-requests/bits';
import { RequestActions } from '@/components/management-requests/request-actions';
import { RequestAppointment } from '@/components/management-requests/request-appointment';
import { RequestThread } from '@/components/management-requests/request-thread';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ManagementRequestDetail } from '@/lib/queries';

function Details({ request }: { request: ManagementRequestDetail }) {
  const { can } = usePermissions();
  return (
    <Card flush>
      <CardHeader title="Request" />
      <CardBody>
        <dl className="dl">
          <dt>Resident</dt>
          <dd>
            {can('residents.read') && !request.author.erased ? (
              <Link className="table__link" href={`/residents/${request.author.id}`}>
                {personName(request.author)}
              </Link>
            ) : (
              personName(request.author)
            )}
          </dd>
          <dt>Unit</dt>
          <dd>{request.unit ? request.unit.code : <span className="t-secondary">Not about a unit</span>}</dd>
          <dt>Topic</dt>
          <dd>{request.topic.nameEn}</dd>
          <dt>Type</dt>
          <dd>{TYPE_TEXT[request.type]}</dd>
          <dt>Assignee</dt>
          <dd>{request.assignee ? personName(request.assignee) : <span className="t-secondary">Unassigned</span>}</dd>
          <dt>Opened</dt>
          <dd>{formatDateTime(request.createdAt)}</dd>
          {request.openedBy ? (
            <>
              <dt>Opened by</dt>
              <dd>
                {personName(request.openedBy)} · {humanize(request.onBehalfReason)}
              </dd>
            </>
          ) : null}
          {request.closedAt ? (
            <>
              <dt>Closed</dt>
              <dd>
                {formatDateTime(request.closedAt)} · {humanize(request.closeReason)}
              </dd>
            </>
          ) : null}
        </dl>
      </CardBody>
    </Card>
  );
}

/** The response clock of the cycle, and the history of escalations. */
function Response({ request }: { request: ManagementRequestDetail }) {
  return (
    <Card flush>
      <CardHeader title="Response" />
      <CardBody>
        <dl className="dl">
          <dt>Now</dt>
          <dd>
            <ResponseBadges request={request} />
          </dd>
          <dt>Due</dt>
          <dd>{formatDateTime(request.responseDueAt)}</dd>
          <dt>First response</dt>
          <dd>{request.firstResponseAt ? formatDateTime(request.firstResponseAt) : <span className="t-secondary">Not yet</span>}</dd>
          {request.answeredAt ? (
            <>
              <dt>Answered</dt>
              <dd>{formatDateTime(request.answeredAt)}</dd>
            </>
          ) : null}
          {request.cycle > 1 ? (
            <>
              <dt>Cycle</dt>
              <dd>{request.cycle} (reopened by the resident)</dd>
            </>
          ) : null}
        </dl>
        {request.escalations.length ? (
          <ul className="list" style={{ marginTop: 12 }}>
            {request.escalations.map((e) => (
              <li key={e.cycle} className="list__item">
                <span className="list__text">
                  Escalated {formatDateTime(e.escalatedAt)}
                  <span className="list__meta">
                    Was due {formatDateTime(e.dueAt)}
                    {request.cycle > 1 ? ` · cycle ${e.cycle}` : ''}
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

/** The resident's rating: read with `requests.manage` only, on its own route. */
function Rating({ requestId }: { requestId: string }) {
  const rating = useQuery({
    queryKey: keys.managementRequestPart(requestId, 'rating'),
    queryFn: () => fetchers.requestRating(requestId),
  });
  const r = rating.data?.rating;
  return (
    <Card flush>
      <CardHeader title="Resident's rating" />
      <CardBody>
        <QueryState query={rating} rows={1}>
          {r ? (
            <>
              <span className="row" style={{ gap: 4 }} title={`${r.rating} of 5`}>
                <Star size={14} aria-hidden />
                <span className="t-num">{r.rating}</span>
                <span className="t-secondary">of 5 · {formatDateTime(r.createdAt)}</span>
              </span>
              {r.comment ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{r.comment}</p> : null}
            </>
          ) : (
            <p className="t-secondary">Not rated yet.</p>
          )}
        </QueryState>
      </CardBody>
    </Card>
  );
}

export default function ManagementRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const request = useQuery({
    queryKey: keys.managementRequest(id),
    queryFn: () => fetchers.managementRequest(id),
    refetchInterval: 60_000,
  });
  const r = request.data;

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/management-requests" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Management requests
          </ButtonLink>
        }
        title={
          r ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {r.number}
              <StatusBadge status={r.status} />
              {r.overdue ? <Badge tone="error">Overdue</Badge> : null}
              {r.escalatedAt ? <Badge tone="terracotta">Escalated</Badge> : null}
            </span>
          ) : (
            'Request'
          )
        }
        description={r ? `${TYPE_TEXT[r.type]} · ${r.topic.nameEn} · ${personName(r.author)}` : undefined}
        actions={r ? <RequestActions request={r} /> : undefined}
      />
      <QueryState query={request}>
        {r ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <RequestThread requestId={r.id} status={r.status} />
            </div>
            <div className="stack">
              <Details request={r} />
              {r.type === 'appointment' ? (
                <RequestAppointment requestId={r.id} number={r.number} requestStatus={r.status} appointment={r.appointment} />
              ) : null}
              <Response request={r} />
              {can('requests.manage') && r.status === 'closed' ? <Rating requestId={r.id} /> : null}
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
