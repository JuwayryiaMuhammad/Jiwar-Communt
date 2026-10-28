'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Segmented, Textarea, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { instantOf, postBody } from '@/components/security/logic';
import { GuardPicker, PostPicker } from '@/components/security/pickers';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { keys, type GuardTaskKind } from '@/lib/queries';

/**
 * A new guard task (ADR 0050), for one guard or for whoever is on shift at
 * a post. Given `request`, it is the closed-unit inspection that answers an
 * owner's inspection request (ADR 0063): the kind and the unit are the
 * request's.
 */
export function NewTaskDialog({
  onClose,
  request,
}: {
  onClose: () => void;
  request?: { id: string; unitId: string; unitCode: string };
}) {
  const toast = useToast();
  const [kind, setKind] = useState<GuardTaskKind>(request ? 'closed_unit_inspection' : 'custom');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [unitId, setUnitId] = useState(request?.unitId ?? '');
  const [to, setTo] = useState<'guard' | 'post'>('post');
  const [guardId, setGuardId] = useState('');
  const [post, setPost] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const target = to === 'guard' ? (guardId ? { guardId } : null) : postBody(post);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/tasks', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            kind,
            ...(kind === 'custom' ? { title: title.trim() } : { unitId }),
            ...(details.trim() ? { details: details.trim() } : {}),
            ...target,
            ...(dueAt ? { dueAt: instantOf(dueAt) } : {}),
            ...(request ? { requestId: request.id } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.guardTasksAll, ['inspection-requests']],
      onDone: () => {
        toast.show('Task given. The guard, or the guards on shift there, are told.');
        onClose();
      },
    },
  );
  const ready = target !== null && (kind === 'custom' ? title.trim() !== '' : unitId !== '');
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New task"
      description="For one guard, or for whoever is on shift at a gate or a zone."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Give task
          </Button>
        </>
      }
    >
      <div className="form">
        {request ? (
          <p className="t-secondary">Inspection of {request.unitCode}, as its owner asked.</p>
        ) : (
          <Segmented<GuardTaskKind>
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'custom', label: 'A task' },
              { value: 'closed_unit_inspection', label: 'Closed unit inspection' },
            ]}
          />
        )}
        {request ? null : kind === 'custom' ? (
          <Field label="Title" error={fieldError(save.error, 'title')}>
            {(p) => <Input {...p} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
        ) : (
          <Field label="Unit" hint="In closed mode: the household turned it on." error={fieldError(save.error, 'unitId')}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        )}
        <Field label="Details" error={fieldError(save.error, 'details')}>
          {(p) => <Textarea {...p} rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} />}
        </Field>
        <Segmented<'guard' | 'post'>
          label="For"
          value={to}
          onChange={setTo}
          options={[
            { value: 'post', label: 'A gate or zone' },
            { value: 'guard', label: 'One guard' },
          ]}
        />
        {to === 'guard' ? (
          <Field label="Guard" error={fieldError(save.error, 'guardId')}>
            {(p) => <GuardPicker {...p} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
          </Field>
        ) : (
          <Field label="Post" error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
            {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
          </Field>
        )}
        <Field label="Due" hint="Optional." error={fieldError(save.error, 'dueAt')}>
          {(p) => <Input {...p} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
