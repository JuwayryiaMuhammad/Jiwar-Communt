'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NameFields, namesReady, NO_NAMES, type Names } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { fetchers, keys, type SuggestionTopic } from '@/lib/queries';
import ar from '@/messages/ar/community-setup';
import en from '@/messages/en/community-setup';

function TopicDialog({ topic, onClose }: { topic: SuggestionTopic | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
  const toast = useToast();
  const [names, setNames] = useState<Names>(topic ? { key: topic.key, nameEn: topic.nameEn, nameAr: topic.nameAr } : NO_NAMES);
  const [active, setActive] = useState(topic?.active ?? true);
  const nameOf = (x: { nameEn: string; nameAr: string }) => (locale === 'ar' ? x.nameAr : x.nameEn);
  const save = useAction(
    () =>
      topic
        ? unwrap(
            api.PATCH('/api/v1/community/suggestion-topics/{id}', {
              params: { path: { id: topic.id } },
              body: { nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), active },
            }),
          )
        : unwrap(
            api.POST('/api/v1/community/suggestion-topics', {
              body: { key: names.key, nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim() },
            }),
          ),
    {
      invalidate: [keys.suggestionTopics],
      onDone: (saved) => {
        toast.show(t('topicSaved', { name: nameOf(saved) }));
        onClose();
      },
    },
  );
  const ready = namesReady(names, !topic);

  return (
    <Dialog
      open
      onClose={onClose}
      title={topic ? t('editTopic', { name: nameOf(topic) }) : t('newTopic')}
      description={t('topicDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!topic} example="parking" />
        {topic ? <Checkbox label={t('topicActive')} checked={active} onChange={(e) => setActive(e.target.checked)} /> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = { topic: SuggestionTopic | null } | null;

/** The compound's suggestion topics (ADR 0040): a closed list of its own. */
export function SuggestionTopics() {
  const t = useT(en, ar);
  const c = useCommonT();
  const topics = useQuery({ queryKey: keys.suggestionTopics, queryFn: fetchers.suggestionTopics });
  const [open, setOpen] = useState<Open>(null);

  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ topic: null })}>
          {t('newTopic')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={topics}>
          <DataTable<SuggestionTopic>
            rows={topics.data?.data}
            rowKey={(x) => x.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'name',
                header: t('col.topic'),
                cell: (x) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary" dir="ltr" lang="en">
                      {x.nameEn}
                    </span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {x.nameAr}
                    </span>
                    {!x.active ? <Badge tone="beige">{t('retired')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'key', header: t('col.code'), cell: (x) => <span className="t-mono">{x.key}</span> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (x) => (
                  <Button size="sm" onClick={() => setOpen({ topic: x })}>
                    {c('edit')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {/* Remounted per topic, so the form starts from the row that was opened. */}
      {open ? <TopicDialog key={open.topic?.id ?? 'new'} topic={open.topic} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
