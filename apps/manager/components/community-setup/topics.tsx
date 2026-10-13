'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NameFields, namesReady, NO_NAMES, type Names } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { fetchers, keys, type SuggestionTopic } from '@/lib/queries';

function TopicDialog({ topic, onClose }: { topic: SuggestionTopic | null; onClose: () => void }) {
  const toast = useToast();
  const [names, setNames] = useState<Names>(topic ? { key: topic.key, nameEn: topic.nameEn, nameAr: topic.nameAr } : NO_NAMES);
  const [active, setActive] = useState(topic?.active ?? true);
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
        toast.show(`${saved.nameEn} is saved.`);
        onClose();
      },
    },
  );
  const ready = namesReady(names, !topic);

  return (
    <Dialog
      open
      onClose={onClose}
      title={topic ? `Edit ${topic.nameEn}` : 'New topic'}
      description="What a resident picks when they write a suggestion."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <NameFields value={names} onChange={setNames} error={save.error} withKey={!topic} example="parking" />
        {topic ? (
          <Checkbox
            label="Offered to residents (unticked: retired, kept on the suggestions that used it)"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = { topic: SuggestionTopic | null } | null;

/** The compound's suggestion topics (ADR 0040): a closed list of its own. */
export function SuggestionTopics() {
  const topics = useQuery({ queryKey: keys.suggestionTopics, queryFn: fetchers.suggestionTopics });
  const [open, setOpen] = useState<Open>(null);

  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setOpen({ topic: null })}>
          New topic
        </Button>
      </div>
      <Card flush>
        <QueryState query={topics}>
          <DataTable<SuggestionTopic>
            rows={topics.data?.data}
            rowKey={(t) => t.id}
            empty="No topic yet"
            emptyHint="Residents cannot send a suggestion until there is one."
            columns={[
              {
                key: 'name',
                header: 'Topic',
                cell: (t) => (
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="table__primary">{t.nameEn}</span>
                    <span className="t-secondary" dir="rtl" lang="ar">
                      {t.nameAr}
                    </span>
                    {!t.active ? <Badge tone="beige">Retired</Badge> : null}
                  </span>
                ),
              },
              { key: 'key', header: 'Code', cell: (t) => <span className="t-mono">{t.key}</span> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (t) => (
                  <Button size="sm" onClick={() => setOpen({ topic: t })}>
                    Edit
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
