'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  StatusBadge,
  Textarea,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { personNameIn, postBody, postNameIn } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardInstruction } from '@/lib/queries';
import ar from '@/messages/ar/sec-instructions';
import en from '@/messages/en/sec-instructions';

type Audience = 'all' | 'post';

function SendDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [audience, setAudience] = useState<Audience>('all');
  const [post, setPost] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const target = postBody(post);
  const send = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/instructions', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            title: title.trim(),
            body: body.trim(),
            urgent,
            ...(audience === 'all'
              ? { audience: 'all' as const }
              : target && 'gateId' in target
                ? { audience: 'gate' as const, gateId: target.gateId }
                : { audience: 'zone' as const, zoneId: target && 'zoneId' in target ? target.zoneId : undefined }),
          },
        }),
      ),
    {
      invalidate: [keys.instructionsAll],
      onDone: (i) => {
        toast.show(t('sent', { n: i.recipients }));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newInstruction')}
      description={t('sendDescription')}
      onSubmit={() => send.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={send.isPending} disabled={!title.trim() || !body.trim() || (audience === 'post' && !target)}>
            {t('send')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('titleLabel')} error={fieldError(send.error, 'title')}>
          {(p) => <Input {...p} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label={t('instruction')} error={fieldError(send.error, 'body')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        <Segmented<Audience>
          label={t('to')}
          value={audience}
          onChange={setAudience}
          options={[
            { value: 'all', label: t('allGuards') },
            { value: 'post', label: t('gateOrZone') },
          ]}
        />
        {audience === 'post' ? (
          <Field label={t('post')} error={fieldError(send.error, 'gateId') ?? fieldError(send.error, 'zoneId')}>
            {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
          </Field>
        ) : null}
        <Checkbox label={t('urgentLabel')} checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        <ErrorAlert error={send.error} />
      </div>
    </Dialog>
  );
}

function InstructionDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const detail = useQuery({ queryKey: keys.instruction(id), queryFn: () => fetchers.instruction(id) });
  const archive = useAction(
    () => unwrap(api.POST('/api/v1/staff/security/instructions/{id}/archive', { params: { path: { id } } })),
    { invalidate: [keys.instructionsAll], onDone: () => toast.show(t('archived')) },
  );
  const i = detail.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={i?.title ?? t('instruction')}
      description={i ? `${i.audience === 'all' ? t('allGuards') : postNameIn(i.post, locale)} · ${f.dateTime(i.createdAt)}` : undefined}
      footer={
        <>
          {i && !i.archivedAt ? (
            <Button loading={archive.isPending} onClick={() => archive.mutate(undefined)}>
              {t('archive')}
            </Button>
          ) : null}
          <Button onClick={onClose}>{c('close')}</Button>
        </>
      }
    >
      <QueryState query={detail} rows={4}>
        {i ? (
          <div className="stack">
            <p style={{ whiteSpace: 'pre-wrap' }}>{i.body}</p>
            <p className="t-secondary">{t('acknowledgedOf', { acknowledged: f.number(i.acknowledged), recipients: f.number(i.recipients) })}</p>
            <DataTable
              rows={i.reached}
              rowKey={(r) => r.guard.id}
              empty={t('emptyReached')}
              columns={[
                { key: 'guard', header: t('guard'), cell: (r) => personNameIn(r.guard, locale) },
                { key: 'via', header: t('reached'), cell: (r) => (r.addedVia === 'send' ? t('whenSent') : t('openingShift')) },
                { key: 'ack', header: t('acknowledged'), cell: (r) => (r.acknowledgedAt ? f.dateTime(r.acknowledgedAt) : t('notYet')) },
              ]}
            />
            <ErrorAlert error={archive.error} />
          </div>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/** Instructions to guards (ADR 0050): sent, acknowledged one by one, archived. */
export default function InstructionsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('guard_instructions.manage');
  const [state, setState] = useState<'live' | 'archived' | ''>('live');
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.instructions(state), (cursor) => fetchers.instructions(state, cursor), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<'live' | 'archived' | ''>
          label={t('shown')}
          value={state}
          onChange={setState}
          options={[
            { value: 'live', label: t('filter.live') },
            { value: 'archived', label: t('filter.archived') },
            { value: '', label: c('all') },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setSending(true)}>
          {t('newInstruction')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<GuardInstruction>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('empty')}
            columns={[
              {
                key: 'title',
                header: t('instruction'),
                cell: (i) => (
                  <span className="row">
                    <Button variant="text" className="table__link" onClick={() => setOpen(i.id)}>
                      {i.title}
                    </Button>
                    {i.urgent ? <Badge tone="error">{t('urgent')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'to', header: t('to'), cell: (i) => (i.audience === 'all' ? t('allGuards') : postNameIn(i.post, locale)) },
              {
                key: 'acks',
                header: t('acknowledged'),
                cell: (i) => (
                  <span className="t-num">
                    {f.number(i.acknowledged)} / {f.number(i.recipients)}
                  </span>
                ),
              },
              { key: 'state', header: t('state'), cell: (i) => <StatusBadge status={i.archivedAt ? 'archived' : 'active'} /> },
              { key: 'when', header: t('sentCol'), cell: (i) => <span title={f.dateTime(i.createdAt)}>{f.relative(i.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {sending ? <SendDialog onClose={() => setSending(false)} /> : null}
      {open ? <InstructionDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
