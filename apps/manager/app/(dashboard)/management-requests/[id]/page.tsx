'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader, StatusBadge, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ResponseBadges, usePersonName } from '@/components/management-requests/bits';
import { localName } from '@/components/management-requests/logic';
import { RequestActions } from '@/components/management-requests/request-actions';
import { RequestDesk } from '@/components/office-queue/request-desk';
import { RequestAppointment } from '@/components/management-requests/request-appointment';
import { RequestThread } from '@/components/management-requests/request-thread';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ManagementRequestDetail } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-mgmt-requests';

function Details({ request }: { request: ManagementRequestDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const personName = usePersonName();
  const { can } = usePermissions();
  return (
    <Card flush>
      <CardHeader title={t('request')} />
      <CardBody>
        <dl className="dl">
          <dt>{t('resident')}</dt>
          <dd>
            {can('residents.read') && !request.author.erased ? (
              <Link className="table__link" href={`/residents/${request.author.id}`}>
                {personName(request.author)}
              </Link>
            ) : (
              personName(request.author)
            )}
          </dd>
          <dt>{c('unit')}</dt>
          <dd>{request.unit ? request.unit.code : <span className="t-secondary">{t('notAboutUnit')}</span>}</dd>
          <dt>{t('topic')}</dt>
          <dd>{localName(locale, request.topic)}</dd>
          <dt>{t('type')}</dt>
          <dd>{t(`type.${request.type}`)}</dd>
          <dt>{t('assignee')}</dt>
          <dd>{request.assignee ? personName(request.assignee) : <span className="t-secondary">{t('unassigned')}</span>}</dd>
          <dt>{t('openedAt')}</dt>
          <dd>{fmt.dateTime(request.createdAt)}</dd>
          {request.openedBy ? (
            <>
              <dt>{t('openedBy')}</dt>
              <dd>
                {personName(request.openedBy)} · {label(request.onBehalfReason)}
              </dd>
            </>
          ) : null}
          {request.closedAt ? (
            <>
              <dt>{t('closedAt')}</dt>
              <dd>
                {fmt.dateTime(request.closedAt)} · {label(request.closeReason)}
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
  const t = useT(en, ar);
  const fmt = useFormat();
  return (
    <Card flush>
      <CardHeader title={t('response')} />
      <CardBody>
        <dl className="dl">
          <dt>{t('now')}</dt>
          <dd>
            <ResponseBadges request={request} />
          </dd>
          <dt>{t('due')}</dt>
          <dd>{fmt.dateTime(request.responseDueAt)}</dd>
          <dt>{t('firstResponse')}</dt>
          <dd>{request.firstResponseAt ? fmt.dateTime(request.firstResponseAt) : <span className="t-secondary">{t('notYet')}</span>}</dd>
          {request.answeredAt ? (
            <>
              <dt>{t('answeredAt')}</dt>
              <dd>{fmt.dateTime(request.answeredAt)}</dd>
            </>
          ) : null}
          {request.cycle > 1 ? (
            <>
              <dt>{t('cycle')}</dt>
              <dd>{t('cycleReopened', { n: request.cycle })}</dd>
            </>
          ) : null}
        </dl>
        {request.escalations.length ? (
          <ul className="list" style={{ marginBlockStart: 12 }}>
            {request.escalations.map((e) => (
              <li key={e.cycle} className="list__item">
                <span className="list__text">
                  {t('escalatedOn', { when: fmt.dateTime(e.escalatedAt) })}
                  <span className="list__meta">
                    {t('wasDue', { when: fmt.dateTime(e.dueAt) })}
                    {request.cycle > 1 ? ` · ${t('cycleN', { n: e.cycle })}` : ''}
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const rating = useQuery({
    queryKey: keys.managementRequestPart(requestId, 'rating'),
    queryFn: () => fetchers.requestRating(requestId),
  });
  const r = rating.data?.rating;
  return (
    <Card flush>
      <CardHeader title={t('rating')} />
      <CardBody>
        <QueryState query={rating} rows={1}>
          {r ? (
            <>
              <span className="row" style={{ gap: 4 }} title={t('ratingOf', { n: r.rating })}>
                <Star size={14} aria-hidden />
                <span className="t-secondary">{t('ratingOf', { n: r.rating })} · {fmt.dateTime(r.createdAt)}</span>
              </span>
              {r.comment ? <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{r.comment}</p> : null}
            </>
          ) : (
            <p className="t-secondary">{t('notRated')}</p>
          )}
        </QueryState>
      </CardBody>
    </Card>
  );
}

export default function ManagementRequestPage() {
  const t = useT(en, ar);
  const { locale } = useLocale();
  const personName = usePersonName();
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
          <ButtonLink href="/management-requests" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('title')}
          </ButtonLink>
        }
        title={
          r ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {r.number}
              <StatusBadge status={r.status} />
              {r.overdue ? <Badge tone="error">{t('overdue')}</Badge> : null}
              {r.escalatedAt ? <Badge tone="terracotta">{t('escalated')}</Badge> : null}
            </span>
          ) : (
            t('request')
          )
        }
        description={r ? `${t(`type.${r.type}`)} · ${localName(locale, r.topic)} · ${personName(r.author)}` : undefined}
        actions={
          r ? (
            <>
              <RequestDesk request={r} />
              <RequestActions request={r} />
            </>
          ) : undefined
        }
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
