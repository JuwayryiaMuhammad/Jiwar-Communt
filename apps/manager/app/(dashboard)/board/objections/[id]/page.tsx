'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, PageHeader, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Back } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BoardObjections } from '@/lib/queries';
import ar from '@/messages/ar/gov-board-objections';
import en from '@/messages/en/gov-board-objections';

type Grounds = BoardObjections['grounds'][number];

/** The board's single answer: once, to every objector, with its reasons. */
function Answer({ publicationId, onClose }: { publicationId: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('answered'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('answerTitle')}
      description={t('answerDescription')}
      onSubmit={() => answer.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={answer.isPending} disabled={!body.trim()}>
            {t('answer')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('boardAnswer')} error={fieldError(answer.error, 'body')}>
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [answering, setAnswering] = useState(false);
  const q = useQuery({ queryKey: keys.boardObjections(id), queryFn: () => fetchers.boardObjections(id), enabled: allowed });
  const back = <Back href="/board/objections" label={t('title')} />;
  if (ready && !allowed)
    return (
      <>
        <PageHeader back={back} title={t('title')} />
        <ForbiddenState />
      </>
    );
  const o = q.data;
  return (
    <>
      <PageHeader
        back={back}
        title={t('ofDecision')}
        actions={
          o && !o.answer && o.count > 0 ? (
            <Button variant="primary" onClick={() => setAnswering(true)}>
              {t('answer')}
            </Button>
          ) : null
        }
      />
      <QueryState query={q}>
        {o ? (
          <div className="stack">
            <Card>
              <dl className="dl">
                <dt>{t('count')}</dt>
                <dd>{fmt.number(o.count)}</dd>
                <dt>{t('takenUntil')}</dt>
                <dd>{fmt.dateTime(o.until)}</dd>
                {o.answer ? (
                  <>
                    <dt>{t('boardAnswer')}</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>
                      {o.answer.body}
                      <br />
                      <span className="t-secondary">{fmt.dateTime(o.answer.at)}</span>
                    </dd>
                  </>
                ) : null}
              </dl>
            </Card>
            <Card flush>
              <CardHeader title={t('grounds')} />
              <DataTable<Grounds>
                rows={o.grounds}
                rowKey={(g) => `${g.at}-${g.grounds ?? ''}`}
                empty={t('noObjection')}
                columns={[
                  {
                    key: 'g',
                    header: t('col.grounds'),
                    cell: (g) => <span style={{ whiteSpace: 'pre-wrap' }}>{g.grounds ?? t('groundsErased')}</span>,
                  },
                  { key: 'a', header: t('col.lodged'), cell: (g) => fmt.dateTime(g.at) },
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
