'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { Badge, ButtonLink, Card, CardBody, CardHeader, ForbiddenState, PageHeader, Segmented, StatusBadge } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { Back, personName, PersonLink } from '@/components/neighbours/bits';
import { ComplaintActions } from '@/components/neighbours/complaint-actions';
import { ComplaintThread } from '@/components/neighbours/complaint-thread';
import { unitText } from '@/components/neighbours/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplaintDetail } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';

const TABS = ['complainant', 'unit', 'notes'] as const;
type Tab = (typeof TABS)[number];

const RECIPIENT_TEXT: Record<string, string> = {
  household: 'The people answering for the household living in the unit',
  owners: 'The unit’s owners: nobody lived there',
};

function Details({ complaint }: { complaint: ComplaintDetail }) {
  return (
    <Card flush>
      <CardHeader title="Complaint" />
      <CardBody>
        <dl className="dl">
          <dt>Category</dt>
          <dd>{complaint.category.nameEn}</dd>
          <dt>Complainant</dt>
          <dd>
            <PersonLink person={complaint.author} />
          </dd>
          <dt>From unit</dt>
          <dd>{complaint.authorUnit ? unitText(complaint.authorUnit) : <span className="t-secondary">No unit now</span>}</dd>
          <dt>Against unit</dt>
          <dd>{unitText(complaint.targetUnit)}</dd>
          <dt>Filed</dt>
          <dd>{formatDateTime(complaint.createdAt)}</dd>
          <dt>Last activity</dt>
          <dd>{formatDateTime(complaint.lastActivityAt)}</dd>
          {complaint.closedAt ? (
            <>
              <dt>Closed</dt>
              <dd>
                {formatDateTime(complaint.closedAt)} · {humanize(complaint.closeReason)}
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
  const h = complaint.unitHistory;
  return (
    <Card flush>
      <CardHeader
        title="Against this unit"
        actions={
          <ButtonLink size="sm" href={`/complaints?unit=${complaint.targetUnit.id}`}>
            See them
          </ButtonLink>
        }
      >
        <span className="t-secondary">Unit {unitText(complaint.targetUnit)}, this complaint included.</span>
      </CardHeader>
      <CardBody>
        <dl className="dl">
          <dt>In all</dt>
          <dd className="t-num">{h.total}</dd>
          <dt>Open</dt>
          <dd className="t-num">{h.open}</dd>
          <dt>Resolved</dt>
          <dd className="t-num">{h.resolved}</dd>
          <dt>Dismissed</dt>
          <dd className="t-num">
            {h.dismissed} <span className="t-secondary">({h.unfounded} as unfounded)</span>
          </dd>
        </dl>
      </CardBody>
    </Card>
  );
}

/** What this complainant has filed before: a pattern, read before deciding. */
function AuthorPattern({ complaint }: { complaint: ComplaintDetail }) {
  const p = complaint.authorPattern;
  return (
    <Card flush>
      <CardHeader
        title="This author"
        actions={
          <ButtonLink size="sm" href={`/complaints?author=${complaint.author.id}`}>
            See them
          </ButtonLink>
        }
      >
        <span className="t-secondary">Every complaint {personName(complaint.author)} filed, this one included.</span>
      </CardHeader>
      <CardBody>
        <dl className="dl">
          <dt>Filed in all</dt>
          <dd className="t-num">{p.total}</dd>
          <dt>Open</dt>
          <dd className="t-num">{p.open}</dd>
          <dt>Dismissed as unfounded</dt>
          <dd className="t-num">{p.dismissedUnfounded}</dd>
          <dt>Against this same unit</dt>
          <dd className="t-num">{p.againstSameUnit}</dd>
        </dl>
      </CardBody>
    </Card>
  );
}

function History({ complaint }: { complaint: ComplaintDetail }) {
  return (
    <Card flush>
      <CardHeader title="History" />
      <ul className="list">
        {complaint.history.map((step, i) => (
          <li key={`${step.at}-${i}`} className="list__item">
            <span className="list__text">
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {step.from === null ? 'Filed' : <StatusBadge status={step.to} />}
                {step.reasonCode ? <span className="t-secondary">{humanize(step.reasonCode)}</span> : null}
              </span>
              <span className="list__meta">
                {personName(step.actor)} · {step.actorSide === 'staff' ? 'management' : 'resident'} · {formatDateTime(step.at)}
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
  const notice = complaint.notice;
  if (!notice) return null;
  return (
    <div style={{ padding: 16, borderBottom: '1px solid var(--hairline-soft)' }}>
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Badge tone="terracotta">The notice</Badge>
        <span className="t-secondary">
          Sent {formatDateTime(notice.sentAt)} by {personName(notice.sentBy)}
        </span>
      </span>
      <p style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{notice.body}</p>
      <dl className="dl">
        <dt>Sent to</dt>
        <dd>{notice.recipients.length ? notice.recipients.map(personName).join(', ') : <span className="t-secondary">Nobody is left of them</span>}</dd>
        <dt>As</dt>
        <dd>{RECIPIENT_TEXT[notice.recipientKind] ?? humanize(notice.recipientKind)}</dd>
      </dl>
    </div>
  );
}

function ComplaintView() {
  const { id } = useParams<{ id: string }>();
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
        <PageHeader back={<Back href="/complaints" label="Complaints" />} title="Complaint" />
        <ForbiddenState />
      </>
    );
  }

  const hasNotice = c ? c.notice !== null : false;
  const complainant = c ? `the complainant, ${personName(c.author)}` : '';
  const unit = c ? `unit ${unitText(c.targetUnit)}` : '';

  return (
    <>
      <PageHeader
        back={<Back href="/complaints" label="Complaints" />}
        title={
          c ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {c.number}
              <StatusBadge status={c.status} />
            </span>
          ) : (
            'Complaint'
          )
        }
        description={c ? `${c.category.nameEn} · against unit ${unitText(c.targetUnit)} · by ${personName(c.author)}` : undefined}
        actions={c ? <ComplaintActions complaint={c} /> : undefined}
      />
      <QueryState query={complaint}>
        {c ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <div className="toolbar" style={{ overflowX: 'auto', marginBottom: 0 }}>
                <Segmented<Tab>
                  label="Thread"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'complainant', label: 'Complainant' },
                    { value: 'unit', label: hasNotice ? 'Unit' : 'Unit (no notice yet)' },
                    { value: 'notes', label: 'Internal notes' },
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
                  never="The unit complained about never sees this thread."
                />
              </div>
              <div hidden={tab !== 'unit'}>
                <ComplaintThread
                  complaintId={c.id}
                  thread="target"
                  status={c.status}
                  hasNotice={hasNotice}
                  to={`${unit}: whoever was sent its notice`}
                  never="The complainant never sees this thread. Do not name them here."
                  lead={<Notice complaint={c} />}
                />
              </div>
              <div hidden={tab !== 'notes'}>
                <ComplaintThread
                  complaintId={c.id}
                  thread="internal"
                  status={c.status}
                  hasNotice={hasNotice}
                  to="the staff who handle complaints"
                  never="Neither the complainant nor the unit ever sees a note."
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
