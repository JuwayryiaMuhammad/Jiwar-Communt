'use client';

import { QueryState } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, ButtonLink, Card, CardBody, CardHeader, ForbiddenState, PageHeader, Segmented, StatusBadge, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { Back, PersonLink } from '@/components/neighbours/bits';
import { ComplaintActions } from '@/components/neighbours/complaint-actions';
import { ComplaintThread } from '@/components/neighbours/complaint-thread';
import { useWho } from '@/components/neighbours/who';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplaintDetail } from '@/lib/queries';
import ar from '@/messages/ar/complaints';
import en from '@/messages/en/complaints';
import { useTab } from '@/lib/use-tab';

const TABS = ['complainant', 'unit', 'notes'] as const;
type Tab = (typeof TABS)[number];

function Details({ complaint }: { complaint: ComplaintDetail }) {
  const t = useT(en, ar);
  const cm = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const who = useWho();
  return (
    <Card flush>
      <CardHeader title={t('complaint')} />
      <CardBody>
        <dl className="dl">
          <dt>{cm('category')}</dt>
          <dd>{locale === 'ar' ? complaint.category.nameAr : complaint.category.nameEn}</dd>
          <dt>{t('complainant')}</dt>
          <dd>
            <PersonLink person={complaint.author} />
          </dd>
          <dt>{t('fromUnit')}</dt>
          <dd>{complaint.authorUnit ? who.unit(complaint.authorUnit) : <span className="t-secondary">{t('noUnitNow')}</span>}</dd>
          <dt>{t('againstUnit')}</dt>
          <dd>{who.unit(complaint.targetUnit)}</dd>
          <dt>{t('filed')}</dt>
          <dd>{f.dateTime(complaint.createdAt)}</dd>
          <dt>{t('lastActivity')}</dt>
          <dd>{f.dateTime(complaint.lastActivityAt)}</dd>
          {complaint.closedAt ? (
            <>
              <dt>{t('closed')}</dt>
              <dd>
                {f.dateTime(complaint.closedAt)} · {label(complaint.closeReason)}
              </dd>
            </>
          ) : null}
        </dl>
      </CardBody>
    </Card>
  );
}

/** What there has been against the same unit, this complaint included. */
function AgainstUnit({ complaint }: { complaint: ComplaintDetail }) {
  const t = useT(en, ar);
  const f = useFormat();
  const who = useWho();
  const h = complaint.unitHistory;
  return (
    <Card flush>
      <CardHeader
        title={t('againstUnitCard')}
        actions={
          <ButtonLink size="sm" href={`/complaints?unit=${complaint.targetUnit.id}`}>
            {t('seeThem')}
          </ButtonLink>
        }
      >
        <span className="t-secondary">{t('unitThisIncluded', { unit: who.unit(complaint.targetUnit) })}</span>
      </CardHeader>
      <CardBody>
        <dl className="dl">
          <dt>{t('inAll')}</dt>
          <dd className="t-num">{f.number(h.total)}</dd>
          <dt>{t('open')}</dt>
          <dd className="t-num">{f.number(h.open)}</dd>
          <dt>{t('resolved')}</dt>
          <dd className="t-num">{f.number(h.resolved)}</dd>
          <dt>{t('dismissed')}</dt>
          <dd className="t-num">
            {f.number(h.dismissed)} <span className="t-secondary">{t('asUnfounded', { count: f.number(h.unfounded) })}</span>
          </dd>
        </dl>
      </CardBody>
    </Card>
  );
}

/** What this complainant has filed before: a pattern, read before deciding. */
function AuthorPattern({ complaint }: { complaint: ComplaintDetail }) {
  const t = useT(en, ar);
  const f = useFormat();
  const who = useWho();
  const p = complaint.authorPattern;
  return (
    <Card flush>
      <CardHeader
        title={t('thisAuthor')}
        actions={
          <ButtonLink size="sm" href={`/complaints?author=${complaint.author.id}`}>
            {t('seeThem')}
          </ButtonLink>
        }
      >
        <span className="t-secondary">{t('everyComplaintBy', { name: who.person(complaint.author) })}</span>
      </CardHeader>
      <CardBody>
        <dl className="dl">
          <dt>{t('filedInAll')}</dt>
          <dd className="t-num">{f.number(p.total)}</dd>
          <dt>{t('open')}</dt>
          <dd className="t-num">{f.number(p.open)}</dd>
          <dt>{t('dismissedUnfounded')}</dt>
          <dd className="t-num">{f.number(p.dismissedUnfounded)}</dd>
          <dt>{t('againstSameUnit')}</dt>
          <dd className="t-num">{f.number(p.againstSameUnit)}</dd>
        </dl>
      </CardBody>
    </Card>
  );
}

function History({ complaint }: { complaint: ComplaintDetail }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const who = useWho();
  return (
    <Card flush>
      <CardHeader title={t('history')} />
      <ul className="list">
        {complaint.history.map((step, i) => (
          <li key={`${step.at}-${i}`} className="list__item">
            <span className="list__text">
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {step.from === null ? t('historyFiled') : <StatusBadge status={step.to} />}
                {step.reasonCode ? <span className="t-secondary">{label(step.reasonCode)}</span> : null}
              </span>
              <span className="list__meta">
                {who.person(step.actor)} · {step.actorSide === 'staff' ? t('sideStaff') : t('sideResident')} · {f.dateTime(step.at)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The one notice the unit was sent: its words, who got them, and when. */
function Notice({ complaint }: { complaint: ComplaintDetail }) {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const who = useWho();
  const notice = complaint.notice;
  if (!notice) return null;
  return (
    <div style={{ padding: 16, borderBottom: '1px solid var(--hairline-soft)' }}>
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge tone="terracotta">{t('noticeBadge')}</Badge>
        <span className="t-secondary">
          {t('noticeSent', { when: f.dateTime(notice.sentAt), name: who.person(notice.sentBy) })}
        </span>
      </span>
      <p style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{notice.body}</p>
      <dl className="dl">
        <dt>{t('sentTo')}</dt>
        <dd>{notice.recipients.length ? f.list(notice.recipients.map(who.person)) : <span className="t-secondary">{t('nobodyLeft')}</span>}</dd>
        <dt>{t('noticeAs')}</dt>
        <dd>{notice.recipientKind === 'household' || notice.recipientKind === 'owners' ? t(`recipient.${notice.recipientKind}`) : label(notice.recipientKind)}</dd>
      </dl>
    </div>
  );
}

function ComplaintView() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const { locale } = useLocale();
  const who = useWho();
  const { can, ready } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'complainant');
  const allowed = can('neighbours.handle');
  const complaint = useQuery({
    queryKey: keys.complaint(id),
    queryFn: () => fetchers.complaint(id),
    refetchInterval: 60_000,
    enabled: allowed,
  });
  const c = complaint.data;

  if (ready && !allowed) {
    return (
      <>
        <PageHeader back={<Back href="/complaints" label={t('title')} />} title={t('complaintTitle')} />
        <ForbiddenState />
      </>
    );
  }

  const hasNotice = c ? c.notice !== null : false;
  const complainant = c ? t('theComplainant', { name: who.person(c.author) }) : '';
  const unit = c ? t('theUnit', { unit: who.unit(c.targetUnit) }) : '';

  return (
    <>
      <PageHeader
        back={<Back href="/complaints" label={t('title')} />}
        title={
          c ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {c.number}
              <StatusBadge status={c.status} />
            </span>
          ) : (
            t('complaintTitle')
          )
        }
        description={
          c
            ? t('detailDescription', {
                category: locale === 'ar' ? c.category.nameAr : c.category.nameEn,
                unit: who.unit(c.targetUnit),
                name: who.person(c.author),
              })
            : undefined
        }
        actions={c ? <ComplaintActions complaint={c} /> : undefined}
      />
      <QueryState query={complaint}>
        {c ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <div className="toolbar" style={{ overflowX: 'auto', marginBottom: 0 }}>
                <Segmented<Tab>
                  label={t('thread')}
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'complainant', label: t('complainant') },
                    { value: 'unit', label: hasNotice ? t('tabUnit') : t('tabUnitNoNotice') },
                    { value: 'notes', label: t('tabNotes') },
                  ]}
                />
              </div>
              {/* All three stay mounted, so a draft is kept when the tab changes; each has its own. */}
              <div hidden={tab !== 'complainant'}>
                <ComplaintThread
                  complaintId={c.id}
                  thread="complainant"
                  status={c.status}
                  hasNotice={hasNotice}
                  to={complainant}
                  never={t('neverUnit')}
                />
              </div>
              <div hidden={tab !== 'unit'}>
                <ComplaintThread
                  complaintId={c.id}
                  thread="target"
                  status={c.status}
                  hasNotice={hasNotice}
                  to={unit}
                  never={t('neverComplainant')}
                  lead={<Notice complaint={c} />}
                />
              </div>
              <div hidden={tab !== 'notes'}>
                <ComplaintThread
                  complaintId={c.id}
                  thread="internal"
                  status={c.status}
                  hasNotice={hasNotice}
                  to={t('theStaff')}
                  never={t('neverNote')}
                />
              </div>
            </div>
            <div className="stack">
              <Details complaint={c} />
              <AgainstUnit complaint={c} />
              <AuthorPattern complaint={c} />
              <History complaint={c} />
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}

export default function ComplaintPage() {
  return (
    <Suspense>
      <ComplaintView />
    </Suspense>
  );
}
