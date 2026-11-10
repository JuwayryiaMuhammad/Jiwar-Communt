'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { localName } from '@/components/management-requests/logic';
import { keys, type ManagementRequestDetail } from '@/lib/queries';
import ar from '@/messages/ar/services-office-queue';
import en from '@/messages/en/services-office-queue';

type Open = 'topic' | 'convert' | null;

/**
 * The office queue's moves on a live request (ADR 0080): another topic, and
 * turning it into a maintenance ticket — the resident's own in the request's
 * unit, or the management's work order on a common area. A converted request
 * closes for good; the resident is told the ticket's number.
 */
export function RequestDesk({ request }: { request: ManagementRequestDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
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
    queryFn: () => unwrap(api.GET('/api/v1/management/request-topics', {})) as Promise<{ data: { id: string; key: string; nameEn: string; nameAr: string; active: boolean }[] }>,
    enabled: open === 'topic',
  });
  const categories = useQuery({
    queryKey: ['maintenance', 'categories'],
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/categories', {})) as Promise<{ data: { id: string; nameEn: string; nameAr: string; active: boolean }[] }>,
    enabled: open === 'convert',
  });
  const close = () => setOpen(null);
  const move = useAction(() => unwrap(api.POST('/api/v1/management/requests/{id}/topic', { ...path, body: { topicId } })), {
    invalidate: [keys.managementAll],
    onDone: () => {
      toast.show(t('movedToast', { number: request.number }));
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
      onDone: (ticket: { id: string; number: string }) => {
        toast.show(t('convertedToast', { number: request.number, ticket: ticket.number }));
        router.push(`/maintenance/${ticket.id}`);
      },
    },
  );
  const live = request.status !== 'closed';
  if (!live || request.about) return null;
  return (
    <>
      <Button onClick={() => setOpen('topic')}>{t('changeTopic')}</Button>
      {can('tickets.dispatch') ? <Button onClick={() => setOpen('convert')}>{t('convert')}</Button> : null}

      <Dialog
        open={open === 'topic'}
        onClose={close}
        title={t('topicTitle', { number: request.number })}
        description={t('topicDescription')}
        onSubmit={() => topicId && move.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={move.isPending} disabled={!topicId}>
              {t('move')}
            </Button>
          </>
        }
      >
        <Field label={t('topic')}>
          {(p) => (
            <Select {...p} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">{t('choose')}</option>
              {(topics.data?.data ?? [])
                .filter((topic) => topic.active && topic.id !== request.topic.id && topic.key !== 'release_request')
                .map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {localName(locale, topic)}
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
        title={t('convertTitle', { number: request.number })}
        description={t('convertDescription')}
        onSubmit={() => categoryId && description.trim() && convert.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={convert.isPending} disabled={!categoryId || !description.trim() || (target === 'work_order' && !commonAreaId)}>
              {t('openTicket')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('ticket')}>
            {(p) => (
              <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as 'ticket' | 'work_order')}>
                {request.unit ? <option value="ticket">{t('residentTicket', { unit: request.unit.code })}</option> : null}
                <option value="work_order">{t('workOrder')}</option>
              </Select>
            )}
          </Field>
          {target === 'work_order' ? (
            <Field label={t('commonArea')} hint={t('commonAreaHint')}>
              {(p) => <Input {...p} value={commonAreaId} onChange={(e) => setCommonAreaId(e.target.value)} />}
            </Field>
          ) : null}
          <Field label={t('category')}>
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t('choose')}</option>
                {(categories.data?.data ?? [])
                  .filter((category) => category.active)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {localName(locale, category)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t('whatToDo')}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <ErrorAlert error={convert.error} />
        </div>
      </Dialog>
    </>
  );
}
