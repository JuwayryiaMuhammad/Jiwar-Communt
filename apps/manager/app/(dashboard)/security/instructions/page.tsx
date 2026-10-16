'use client';

import { formatDateTime, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { personName, postBody, postName } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardInstruction } from '@/lib/queries';

type Audience = 'all' | 'post';

function SendDialog({ onClose }: { onClose: () => void }) {
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
        toast.show(`Sent to ${i.recipients} guard${i.recipients === 1 ? '' : 's'}.`);
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New instruction"
      description="Every guard it reaches acknowledges it. At a gate or a zone it reaches the guards there and those scheduled there this week, and anyone who opens a shift there while it is live."
      onSubmit={() => send.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={send.isPending} disabled={!title.trim() || !body.trim() || (audience === 'post' && !target)}>
            Send
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Title" error={fieldError(send.error, 'title')}>
          {(p) => <Input {...p} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Instruction" error={fieldError(send.error, 'body')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        <Segmented<Audience>
          label="To"
          value={audience}
          onChange={setAudience}
          options={[
            { value: 'all', label: 'All guards' },
            { value: 'post', label: 'A gate or zone' },
          ]}
        />
        {audience === 'post' ? (
          <Field label="Post" error={fieldError(send.error, 'gateId') ?? fieldError(send.error, 'zoneId')}>
            {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
          </Field>
        ) : null}
        <Checkbox label="Urgent: a critical push, even in quiet hours" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        <ErrorAlert error={send.error} />
      </div>
    </Dialog>
  );
}

function InstructionDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const detail = useQuery({ queryKey: keys.instruction(id), queryFn: () => fetchers.instruction(id) });
  const archive = useAction(
    () => unwrap(api.POST('/api/v1/staff/security/instructions/{id}/archive', { params: { path: { id } } })),
    { invalidate: [keys.instructionsAll], onDone: () => toast.show('Archived: it reaches nobody new.') },
  );
  const i = detail.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={i?.title ?? 'Instruction'}
      description={i ? `${i.audience === 'all' ? 'All guards' : postName(i.post)} · ${formatDateTime(i.createdAt)}` : undefined}
      footer={
        <>
          {i && !i.archivedAt ? (
            <Button loading={archive.isPending} onClick={() => archive.mutate(undefined)}>
              Archive
            </Button>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <QueryState query={detail} rows={4}>
        {i ? (
          <div className="stack">
            <p style={{ whiteSpace: 'pre-wrap' }}>{i.body}</p>
            <p className="t-secondary">
              {i.acknowledged} of {i.recipients} acknowledged.
            </p>
            <DataTable
              rows={i.reached}
              rowKey={(r) => r.guard.id}
              empty="It reaches nobody yet"
              columns={[
                { key: 'guard', header: 'Guard', cell: (r) => personName(r.guard) },
                { key: 'via', header: 'Reached', cell: (r) => (r.addedVia === 'send' ? 'When sent' : 'Opening a shift') },
                { key: 'ack', header: 'Acknowledged', cell: (r) => (r.acknowledgedAt ? formatDateTime(r.acknowledgedAt) : 'Not yet') },
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
  const { ready, can } = usePermissions();
  const allowed = can('guard_instructions.manage');
  const [state, setState] = useState<'live' | 'archived' | ''>('live');
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.instructions(state), (c) => fetchers.instructions(state, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Instructions to guards" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Instructions to guards" description="Each guard it reaches must acknowledge it." />
      <div className="toolbar">
        <Segmented<'live' | 'archived' | ''>
          label="Instructions shown"
          value={state}
          onChange={setState}
          options={[
            { value: 'live', label: 'Live' },
            { value: 'archived', label: 'Archived' },
            { value: '', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setSending(true)}>
          New instruction
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<GuardInstruction>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty="No instruction"
            columns={[
              {
                key: 'title',
                header: 'Instruction',
                cell: (i) => (
                  <span className="row">
                    <Button variant="text" className="table__link" onClick={() => setOpen(i.id)}>
                      {i.title}
                    </Button>
                    {i.urgent ? <Badge tone="error">Urgent</Badge> : null}
                  </span>
                ),
              },
              { key: 'to', header: 'To', cell: (i) => (i.audience === 'all' ? 'All guards' : postName(i.post)) },
              { key: 'acks', header: 'Acknowledged', cell: (i) => <span className="t-num">{i.acknowledged} / {i.recipients}</span> },
              { key: 'state', header: 'State', cell: (i) => <StatusBadge status={i.archivedAt ? 'archived' : 'active'} /> },
              { key: 'when', header: 'Sent', cell: (i) => <span title={formatDateTime(i.createdAt)}>{relativeTime(i.createdAt)}</span> },
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
