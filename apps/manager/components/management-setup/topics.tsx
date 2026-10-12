'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Dialog, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NameFields, namesReady, NO_NAMES, type Names } from '@/components/maintenance-setup/names';
import { api } from '@/lib/api';
import { fetchers, keys, type RequestTopic } from '@/lib/queries';

const HOURS = { min: 1, max: 720 };
const validHours = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= HOURS.min && n <= HOURS.max;
};

/** "48 hours (2 days)". */
export function targetText(hours: number): string {
  const days = hours / 24;
  return `${hours} hour${hours === 1 ? '' : 's'}${hours >= 24 && Number.isInteger(days) ? ` (${days} day${days === 1 ? '' : 's'})` : ''}`;
}

function TopicDialog({ topic, open, onClose }: { topic: RequestTopic | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [names, setNames] = useState<Names>(topic ? { key: topic.key, nameEn: topic.nameEn, nameAr: topic.nameAr } : NO_NAMES);
  const [hours, setHours] = useState(topic ? String(topic.targetResponseHours) : '48');
  const [active, setActive] = useState(topic?.active ?? true);
  const save = useAction(
    () =>
      topic
        ? unwrap(
            api.PATCH('/api/v1/management/request-topics/{id}', {
              params: { path: { id: topic.id } },
              body: { nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), targetResponseHours: Number(hours), active },
            }),
          )
        : unwrap(
            api.POST('/api/v1/management/request-topics', {
              body: { key: names.key, nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), targetResponseHours: Number(hours) },
            }),
          ),
    {
      invalidate: [keys.requestTopics, keys.requestTopicOptions],
      onDone: (saved) => {
        toast.show(`${saved.nameEn} is saved.`);
        onClose();
      },
    },
  );
  const ready = namesReady(names, !topic) && validHours(hours);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={topic ? `Edit ${topic.nameEn}` : 'New topic'}
      description="What residents pick when they write to the management. The target is how long the management gives itself to respond."
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
        <Field
          label="Response target, in hours"
          hint="A request with no response by then is overdue and escalated once. A change applies to requests opened or reopened from now on."
          error={fieldError(save.error, 'targetResponseHours') ?? (hours !== '' && !validHours(hours) ? `A whole number from ${HOURS.min} to ${HOURS.max}.` : undefined)}
        >
          {(p) => <Input {...p} type="number" min={HOURS.min} max={HOURS.max} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />}
        </Field>
        {topic ? (
          <Checkbox
            label="Offered to residents (unticked: retired, kept on the requests that used it)"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = { topic: RequestTopic | null } | null;

/** The compound's request topics and their response targets (ADR 0039). */
export function Topics() {
  const topics = useQuery({ queryKey: keys.requestTopics, queryFn: fetchers.requestTopics });
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
          <DataTable<RequestTopic>
            rows={topics.data?.data}
            rowKey={(t) => t.id}
            empty="No topic yet"
            emptyHint="Residents cannot write to the management until there is one."
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
              { key: 'target', header: 'Response target', cell: (t) => targetText(t.targetResponseHours) },
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
      {open ? <TopicDialog key={open.topic?.id ?? 'new'} topic={open.topic} open onClose={() => setOpen(null)} /> : null}
    </>
  );
}
