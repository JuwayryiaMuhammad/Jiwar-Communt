'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Segmented, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { instantOf, postBody } from '@/components/security/logic';
import { GuardPicker, PostPicker } from '@/components/security/pickers';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { keys, type GuardTaskKind } from '@/lib/queries';
import ar from '@/messages/ar/sec-new-task';
import en from '@/messages/en/sec-new-task';

/**
 * A new guard task (ADR 0050), for one guard or for whoever is on shift at
 * a post. Given `request`, it is the closed-unit inspection that answers an
 * owner's inspection request (ADR 0063); given `round`, the one that carries
 * out a closed unit's round (ADR 0083): the kind and the unit are theirs.
 */
export function NewTaskDialog({
  onClose,
  request: asked,
  round,
}: {
  onClose: () => void;
  request?: { id: string; unitId: string; unitCode: string };
  round?: { id: string; unitId: string; unitCode: string };
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const request = asked ?? round;
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
            ...(asked ? { requestId: asked.id } : {}),
            ...(round ? { roundId: round.id } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.guardTasksAll, ['inspection-requests'], ['closed-units']],
      onDone: () => {
        toast.show(t('given'));
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
      title={t('title')}
      description={t('description')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('giveTask')}
          </Button>
        </>
      }
    >
      <div className="form">
        {request ? (
          <p className="t-secondary">{t(round ? 'inspectionDue' : 'inspectionAsked', { unit: request.unitCode })}</p>
        ) : (
          <Segmented<GuardTaskKind>
            label={c('kind')}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'custom', label: t('kind.custom') },
              { value: 'closed_unit_inspection', label: t('kind.closed_unit_inspection') },
            ]}
          />
        )}
        {request ? null : kind === 'custom' ? (
          <Field label={t('titleLabel')} error={fieldError(save.error, 'title')}>
            {(p) => <Input {...p} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
        ) : (
          <Field label={c('unit')} hint={t('unitHint')} error={fieldError(save.error, 'unitId')}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        )}
        <Field label={t('details')} error={fieldError(save.error, 'details')}>
          {(p) => <Textarea {...p} rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} />}
        </Field>
        <Segmented<'guard' | 'post'>
          label={t('forLabel')}
          value={to}
          onChange={setTo}
          options={[
            { value: 'post', label: t('gateOrZone') },
            { value: 'guard', label: t('oneGuard') },
          ]}
        />
        {to === 'guard' ? (
          <Field label={t('guard')} error={fieldError(save.error, 'guardId')}>
            {(p) => <GuardPicker {...p} value={guardId} onChange={(e) => setGuardId(e.target.value)} />}
          </Field>
        ) : (
          <Field label={t('post')} error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
            {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
          </Field>
        )}
        <Field label={t('due')} hint={c('optional')} error={fieldError(save.error, 'dueAt')}>
          {(p) => <Input {...p} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
