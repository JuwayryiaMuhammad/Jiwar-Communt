'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys, type ManagementRequestDetail } from '@/lib/queries';

type Open = 'topic' | 'convert' | null;

/**
 * The office queue's moves on a live request (ADR 0080): another topic, and
 * turning it into a maintenance ticket — the resident's own in the request's
 * unit, or the management's work order on a common area. A converted request
 * closes for good; the resident is told the ticket's number.
 */
export function RequestDesk({ request }: { request: ManagementRequestDetail }) {
  const toast = useToast();
  const router = useRouter();
  const { can } = usePermissions();
  const [open, setOpen] = useState<Open>(null);
  const [topicId, setTopicId] = useState('');
  const [target, setTarget] = useState<'ticket' | 'work_order'>(request.unit ? 'ticket' : 'work_order');
  const [categoryId, setCategoryId] = useState('');
  const [commonAreaId, setCommonAreaId] = useState('');
  const [description, setDescription] = useState('');
  const path = { params: { path: { id: request.id } } };
  const topics = useQuery({
    queryKey: ['management', 'topics'],
    queryFn: () => unwrap(api.GET('/api/v1/management/request-topics', {})) as Promise<{ data: { id: string; key: string; nameEn: string; active: boolean }[] }>,
    enabled: open === 'topic',
  });
  const categories = useQuery({
    queryKey: ['maintenance', 'categories'],
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/categories', {})) as Promise<{ data: { id: string; nameEn: string; active: boolean }[] }>,
    enabled: open === 'convert',
  });
  const close = () => setOpen(null);
  const move = useAction(() => unwrap(api.POST('/api/v1/management/requests/{id}/topic', { ...path, body: { topicId } })), {
    invalidate: [keys.managementAll],
    onDone: () => {
      toast.show(`${request.number} is under its new topic.`);
      close();
    },
  });
  const convert = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/management/requests/{id}/convert', {
          ...path,
          body: {
            target,
            categoryId,
            description: description.trim(),
            ...(target === 'work_order' ? { commonAreaId } : {}),
          },
        }),
      ) as Promise<{ id: string; number: string }>,
    {
      invalidate: [keys.managementAll],
      onDone: (t: { id: string; number: string }) => {
        toast.show(`${request.number} became ${t.number}. The resident was told.`);
        router.push(`/maintenance/${t.id}`);
      },
    },
  );
  const live = request.status !== 'closed';
  if (!live || request.about) return null;
  return (
    <>
      <Button onClick={() => setOpen('topic')}>Change topic</Button>
      {can('tickets.dispatch') ? <Button onClick={() => setOpen('convert')}>Turn into a ticket</Button> : null}

      <Dialog
        open={open === 'topic'}
        onClose={close}
        title={`Another topic for ${request.number}`}
        description="Its response time follows the new topic’s target from the start of this cycle. The new topic’s handlers are told when nobody holds it."
        onSubmit={() => topicId && move.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={move.isPending} disabled={!topicId}>
              Move
            </Button>
          </>
        }
      >
        <Field label="Topic">
          {(p) => (
            <Select {...p} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">Choose…</option>
              {(topics.data?.data ?? [])
                .filter((t) => t.active && t.id !== request.topic.id && t.key !== 'release_request')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nameEn}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={move.error} />
      </Dialog>

      <Dialog
        open={open === 'convert'}
        onClose={close}
        title={`Turn ${request.number} into a ticket`}
        description="The request closes for good and the work goes on in the ticket. The resident is told its number."
        onSubmit={() => categoryId && description.trim() && convert.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={convert.isPending} disabled={!categoryId || !description.trim() || (target === 'work_order' && !commonAreaId)}>
              Open the ticket
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Ticket">
            {(p) => (
              <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as 'ticket' | 'work_order')}>
                {request.unit ? <option value="ticket">The resident’s ticket in {request.unit.code}</option> : null}
                <option value="work_order">A work order on a common area</option>
              </Select>
            )}
          </Field>
          {target === 'work_order' ? (
            <Field label="Common area id" hint="The common area the fault is in.">
              {(p) => <Input {...p} value={commonAreaId} onChange={(e) => setCommonAreaId(e.target.value)} />}
            </Field>
          ) : null}
          <Field label="Category">
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose…</option>
                {(categories.data?.data ?? [])
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameEn}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="What is to be done">
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <ErrorAlert error={convert.error} />
        </div>
      </Dialog>
    </>
  );
}
