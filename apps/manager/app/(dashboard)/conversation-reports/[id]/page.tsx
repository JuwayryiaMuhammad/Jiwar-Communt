'use client';

import { ApiError, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ForbiddenState, PageHeader, ReasonCodeDialog, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back, personName, PersonLink } from '@/components/neighbours/bits';
import { isSealed, KIND_TEXT, SEALED_TEXT, SIDE_TEXT } from '@/components/neighbours/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ConversationReport, type ReportedMessage } from '@/lib/queries';

type Party = ConversationReport['author'];

function PartyLine({ label, party, reported }: { label: string; party: Party; reported: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <PersonLink person={party.account} />
          {reported ? <Badge tone="terracotta">Reported</Badge> : <Badge plain>Reporter</Badge>}
        </span>
        <span className="t-secondary">
          {party.unitCode ? `Unit ${party.unitCode}${party.building ? ` · ${party.building}` : ''}` : 'No unit now'}
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
  const open = report.status === 'open';
  const list = useCursorList<ReportedMessage>(
    keys.conversationReportMessages(report.id),
    (cursor) => unwrap(api.GET('/api/v1/neighbours/reports/{id}/messages', { params: { path: { id: report.id }, query: { cursor, limit: 50 } } })),
    { enabled: open, refetchInterval: 60_000 },
  );
  const code = list.error instanceof ApiError ? list.error.code : null;

  return (
    <Card flush>
      <CardHeader title="The conversation">
        <span className="t-secondary">Between the two residents, about the post. Shown to the staff for this case only.</span>
      </CardHeader>
      {isSealed(report.status, code) ? (
        <div className="state">
          <Lock aria-hidden />
          <p className="state__title">{SEALED_TEXT}</p>
        </div>
      ) : (
        <QueryState query={list} rows={3}>
          {list.rows?.length ? (
            <div className="thread" style={{ maxHeight: 560 }}>
              {list.rows.map((m) => (
                <div key={m.id} className={`thread__msg${m.side === 'author' ? ' thread__msg--staff' : ''}`}>
                  <span className="thread__meta">
                    {personName(m.sender)} · {SIDE_TEXT[m.side] ?? m.side} · {formatDateTime(m.createdAt)}
                  </span>
                  {m.erased ? <p className="thread__body t-secondary">Message removed</p> : <p className="thread__body">{m.body}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="t-secondary" style={{ padding: 16 }}>
              Nothing was written in it.
            </p>
          )}
          <LoadMore query={list} />
        </QueryState>
      )}
    </Card>
  );
}

function CloseCase({ report }: { report: ConversationReport }) {
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
        toast.show('The case is closed. The conversation is sealed again.');
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
        Close case
      </Button>
      <ReasonCodeDialog
        open={open}
        onClose={close}
        title="Close this case?"
        description="The reporter is told the report was looked at, and nothing of what was decided. The conversation can no longer be read here afterwards."
        codes={REASON_CODES.neighbourReportOutcome}
        codeLabel="What was done"
        confirmLabel="Close case"
        pending={closeCase.isPending}
        error={<ErrorAlert error={closeCase.error} />}
        onConfirm={(code) => closeCase.mutate(code)}
      >
        <Alert tone="warn">
          “Post removed” takes the post off its board at once, and its author is told that the management removed it. “Warned” and “No action” only
          record what you did: the dashboard sends no warning itself.
        </Alert>
      </ReasonCodeDialog>
    </>
  );
}

export default function ConversationReportPage() {
  const { id } = useParams<{ id: string }>();
  const { can, ready } = usePermissions();
  const allowed = can('neighbours.handle');
  const report = useQuery({
    queryKey: keys.conversationReport(id),
    queryFn: () => fetchers.conversationReport(id),
    refetchInterval: 60_000,
    enabled: allowed,
  });
  const r = report.data;
  const back = <Back href="/conversation-reports" label="Conversation reports" />;

  if (ready && !allowed) {
    return (
      <>
        <PageHeader back={back} title="Reported conversation" />
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
              Reported conversation
              <StatusBadge status={r.status} />
            </span>
          ) : (
            'Reported conversation'
          )
        }
        description={r ? `${humanize(r.reasonCode)} · reported by ${personName(r.reporter)} on ${formatDateTime(r.createdAt)}` : undefined}
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
                <CardHeader title="The report" />
                <CardBody>
                  <dl className="dl">
                    <dt>Reason</dt>
                    <dd>{humanize(r.reasonCode)}</dd>
                    <dt>What the reporter said</dt>
                    <dd>{r.note ? <span style={{ whiteSpace: 'pre-wrap' }}>{r.note}</span> : <span className="t-secondary">Nothing more</span>}</dd>
                    <dt>Reported</dt>
                    <dd>{formatDateTime(r.createdAt)}</dd>
                    {r.status === 'closed' ? (
                      <>
                        <dt>Outcome</dt>
                        <dd>{humanize(r.outcome)}</dd>
                        <dt>Closed</dt>
                        <dd>
                          {formatDateTime(r.closedAt)}
                          {r.closedBy ? ` · ${personName(r.closedBy)}` : ''}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title="The two residents" />
                <CardBody>
                  <dl className="dl">
                    <PartyLine label="Post author" party={r.author} reported={r.reporterSide !== 'author'} />
                    <PartyLine label="Responder" party={r.responder} reported={r.reporterSide !== 'responder'} />
                  </dl>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader
                  title="The post"
                  actions={
                    <span className="row" style={{ gap: 8 }}>
                      <Badge plain>{KIND_TEXT[r.post.kind] ?? r.post.kind}</Badge>
                      <StatusBadge status={r.post.state} />
                    </span>
                  }
                />
                <CardBody>
                  {r.post.body === null ? <p className="t-secondary">Text removed.</p> : <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.post.body}</p>}
                  <p style={{ margin: '8px 0 0' }}>
                    <Link className="table__link" href={`/lost-found/${r.post.id}`}>
                      Open the post
                    </Link>
                  </p>
                </CardBody>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}
