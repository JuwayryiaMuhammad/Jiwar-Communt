'use client';

import { ApiError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ForbiddenState, PageHeader, ReasonCodeDialog, StatusBadge, useLabel, useToast } from '@jiwar/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back, PersonLink } from '@/components/neighbours/bits';
import { isSealed } from '@/components/neighbours/logic';
import { useWho } from '@/components/neighbours/who';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ConversationReport, type ReportedMessage } from '@/lib/queries';
import ar from '@/messages/ar/conv-reports';
import en from '@/messages/en/conv-reports';

type Party = ConversationReport['author'];

function PartyLine({ label, party, reported }: { label: string; party: Party; reported: boolean }) {
  const t = useT(en, ar);
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <PersonLink person={party.account} />
          {reported ? <Badge tone="terracotta">{t('partyReported')}</Badge> : <Badge plain>{t('partyReporter')}</Badge>}
        </span>
        <span className="t-secondary">
          {party.unitCode
            ? party.building
              ? t('unitIn', { code: party.unitCode, building: party.building })
              : t('unitCode', { code: party.unitCode })
            : t('noUnitNow')}
        </span>
      </dd>
    </>
  );
}

/**
 * The reported conversation, oldest first: read only while the case is
 * open. Once closed the API answers NEIGHBOUR_REPORT_CLOSED, which is shown
 * as what it is — the conversation sealed again — and never as an error.
 */
function Conversation({ report }: { report: ConversationReport }) {
  const t = useT(en, ar);
  const f = useFormat();
  const who = useWho();
  const sideText = (side: string) => (side === 'author' || side === 'responder' ? t(`side.${side}`) : side);
  const open = report.status === 'open';
  const list = useCursorList<ReportedMessage>(
    keys.conversationReportMessages(report.id),
    (cursor) => unwrap(api.GET('/api/v1/neighbours/reports/{id}/messages', { params: { path: { id: report.id }, query: { cursor, limit: 50 } } })),
    { enabled: open, refetchInterval: 60_000 },
  );
  const code = list.error instanceof ApiError ? list.error.code : null;

  return (
    <Card flush>
      <CardHeader title={t('conversation')}>
        <span className="t-secondary">{t('conversationNote')}</span>
      </CardHeader>
      {isSealed(report.status, code) ? (
        <div className="state">
          <Lock aria-hidden />
          <p className="state__title">{t('sealed')}</p>
        </div>
      ) : (
        <QueryState query={list} rows={3}>
          {list.rows?.length ? (
            <div className="thread" style={{ maxHeight: 560 }}>
              {list.rows.map((m) => (
                <div key={m.id} className={`thread__msg${m.side === 'author' ? ' thread__msg--staff' : ''}`}>
                  <span className="thread__meta">
                    {who.person(m.sender)} · {sideText(m.side)} · {f.dateTime(m.createdAt)}
                  </span>
                  {m.erased ? <p className="thread__body t-secondary">{t('messageRemoved')}</p> : <p className="thread__body">{m.body}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="t-secondary" style={{ padding: 16 }}>
              {t('nothingWritten')}
            </p>
          )}
          <LoadMore query={list} />
        </QueryState>
      )}
    </Card>
  );
}

function CloseCase({ report }: { report: ConversationReport }) {
  const t = useT(en, ar);
  const toast = useToast();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const closeCase = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/neighbours/reports/{id}/close', { params: { path: { id: report.id } }, body: { reasonCode } })),
    {
      // "Post removed" takes the post down with the case.
      invalidate: [keys.conversationReportsAll, keys.neighbourPostsAll],
      onDone: () => {
        // Sealed: what was read of it does not stay in this browser either.
        client.removeQueries({ queryKey: keys.conversationReportMessages(report.id) });
        toast.show(t('caseClosedToast'));
        setOpen(false);
      },
    },
  );
  if (report.status !== 'open') return null;
  const close = () => {
    setOpen(false);
    closeCase.reset();
  };
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t('closeCase')}
      </Button>
      <ReasonCodeDialog
        open={open}
        onClose={close}
        title={t('closeTitle')}
        description={t('closeDescription')}
        codes={REASON_CODES.neighbourReportOutcome}
        codeLabel={t('whatWasDone')}
        confirmLabel={t('closeCase')}
        pending={closeCase.isPending}
        error={<ErrorAlert error={closeCase.error} />}
        onConfirm={(code) => closeCase.mutate(code)}
      >
        <Alert tone="warn">
          {t('closeWarning')}
        </Alert>
      </ReasonCodeDialog>
    </>
  );
}

export default function ConversationReportPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const who = useWho();
  const kindText = (kind: string) => (kind === 'lost' || kind === 'found' || kind === 'lend' || kind === 'borrow' ? t(`kind.${kind}`) : label(kind));
  const { can, ready } = usePermissions();
  const allowed = can('neighbours.handle');
  const report = useQuery({
    queryKey: keys.conversationReport(id),
    queryFn: () => fetchers.conversationReport(id),
    refetchInterval: 60_000,
    enabled: allowed,
  });
  const r = report.data;
  const back = <Back href="/conversation-reports" label={t('title')} />;

  if (ready && !allowed) {
    return (
      <>
        <PageHeader back={back} title={t('reportedConversation')} />
        <ForbiddenState />
      </>
    );
  }

  return (
    <>
      <PageHeader
        back={back}
        title={
          r ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {t('reportedConversation')}
              <StatusBadge status={r.status} />
            </span>
          ) : (
            t('reportedConversation')
          )
        }
        description={
          r ? `${label(r.reasonCode)} · ${t('reportedAnd', { name: who.person(r.reporter), when: f.dateTime(r.createdAt) })}` : undefined
        }
        actions={r ? <CloseCase report={r} /> : undefined}
      />
      <QueryState query={report}>
        {r ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Conversation report={r} />
            </div>
            <div className="stack">
              <Card flush>
                <CardHeader title={t('theReport')} />
                <CardBody>
                  <dl className="dl">
                    <dt>{t('reason')}</dt>
                    <dd>{label(r.reasonCode)}</dd>
                    <dt>{t('reporterSaid')}</dt>
                    <dd>{r.note ? <span style={{ whiteSpace: 'pre-wrap' }}>{r.note}</span> : <span className="t-secondary">{t('nothingMore')}</span>}</dd>
                    <dt>{t('reported')}</dt>
                    <dd>{f.dateTime(r.createdAt)}</dd>
                    {r.status === 'closed' ? (
                      <>
                        <dt>{t('outcome')}</dt>
                        <dd>{label(r.outcome)}</dd>
                        <dt>{t('closed')}</dt>
                        <dd>
                          {f.dateTime(r.closedAt)}
                          {r.closedBy ? ` · ${who.person(r.closedBy)}` : ''}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title={t('twoResidents')} />
                <CardBody>
                  <dl className="dl">
                    <PartyLine label={r.post ? t('postAuthor') : t('seller')} party={r.author} reported={r.reporterSide !== 'author'} />
                    <PartyLine label={t('responder')} party={r.responder} reported={r.reporterSide !== 'responder'} />
                  </dl>
                </CardBody>
              </Card>
              {r.post ? (
                <Card flush>
                  <CardHeader
                    title={t('thePost')}
                    actions={
                      <span className="row" style={{ gap: 8 }}>
                        <Badge plain>{kindText(r.post.kind)}</Badge>
                        <StatusBadge status={r.post.state} />
                      </span>
                    }
                  />
                  <CardBody>
                    {r.post.body === null ? <p className="t-secondary">{t('textRemoved')}</p> : <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.post.body}</p>}
                    <p style={{ margin: '8px 0 0' }}>
                      <Link className="table__link" href={`/lost-found/${r.post.id}`}>
                        {t('openPost')}
                      </Link>
                    </p>
                  </CardBody>
                </Card>
              ) : r.listing ? (
                // A listing's conversation (ADR 0071): closing it `post_removed` takes the listing off the market.
                <Card flush>
                  <CardHeader
                    title={t('theListing')}
                    actions={
                      <span className="row" style={{ gap: 8 }}>
                        <Badge plain>{kindText(r.listing.kind)}</Badge>
                        <StatusBadge status={r.listing.state} />
                      </span>
                    }
                  />
                  <CardBody>
                    {r.listing.title === null ? <p className="t-secondary">{t('textRemoved')}</p> : <p style={{ margin: 0 }}>{r.listing.title}</p>}
                    <p style={{ margin: '8px 0 0' }}>
                      <Link className="table__link" href="/market">
                        {t('openMarket')}
                      </Link>
                    </p>
                  </CardBody>
                </Card>
              ) : null}
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
