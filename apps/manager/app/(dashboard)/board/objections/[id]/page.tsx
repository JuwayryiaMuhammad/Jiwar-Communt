'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, PageHeader, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardObjections } from '@/lib/queries';

type Grounds = BoardObjections['grounds'][number];

/** The board's single answer: once, to every objector, with its reasons. */
function Answer({ publicationId, onClose }: { publicationId: string; onClose: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const answer = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/publications/{id}/objections/answer', {
          params: { path: { id: publicationId } },
          body: { body: body.trim() },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show('Answered. Every objector was told; the decision takes no more objections.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Answer the objections"
      description="Once, for the board: every objector reads it, and the decision takes no more objections after. Write no one’s name."
      onSubmit={() => answer.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={answer.isPending} disabled={!body.trim()}>
            Answer
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="The board’s answer" error={fieldError(answer.error, 'body')}>
          {(p) => <Textarea {...p} rows={8} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        <ErrorAlert error={answer.error} />
      </div>
    </Dialog>
  );
}

/**
 * A decision's objections as the board reads them (ADR 0059): how many,
 * and their grounds, never whose; and the board's one answer.
 */
export default function BoardObjectionsOfDecisionPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [answering, setAnswering] = useState(false);
  const q = useQuery({ queryKey: keys.boardObjections(id), queryFn: () => fetchers.boardObjections(id), enabled: allowed });
  const back = <Back href="/board/objections" label="Objections" />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title="Objections" />
        <ForbiddenState />
      </>
    );
  const o = q.data;
  return (
    <>
      <PageHeader
        back={back}
        title="Objections to a decision"
        actions={
          o && !o.answer && o.count > 0 ? (
            <Button variant="primary" onClick={() => setAnswering(true)}>
              Answer
            </Button>
          ) : null
        }
      />
      <QueryState query={q}>
        {o ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>Objections</dt>
                <dd>{o.count}</dd>
                <dt>Taken until</dt>
                <dd>{formatDateTime(o.until)}</dd>
                {o.answer ? (
                  <>
                    <dt>The board’s answer</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>
                      {o.answer.body}
                      <br />
                      <span className="t-secondary">{formatDateTime(o.answer.at)}</span>
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card flush>
              <CardHeader title="Their grounds" />
              <DataTable<Grounds>
                rows={o.grounds}
                rowKey={(g) => `${g.at}-${g.grounds ?? ''}`}
                empty="No objection"
                columns={[
                  {
                    key: 'g',
                    header: 'Grounds',
                    cell: (g) => <span style={{ whiteSpace: 'pre-wrap' }}>{g.grounds ?? 'Removed: its owner’s account was erased.'}</span>,
                  },
                  { key: 'a', header: 'Lodged', cell: (g) => formatDateTime(g.at) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      {answering ? <Answer publicationId={id} onClose={() => setAnswering(false)} /> : null}
    </>
  );
}
