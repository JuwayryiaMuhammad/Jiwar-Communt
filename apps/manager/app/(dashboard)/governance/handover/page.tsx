'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, Card, CardHeader, ConfirmDialog, Field, ForbiddenState, PageHeader, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-handover';
import en from '@/messages/en/gov-handover';

/**
 * A manager's handover (ADR 0075): notes in their own words, delivered
 * once with a snapshot of what waits for the office. While a board sits,
 * a manager who delivered none cannot be deactivated unless the board
 * approved going without.
 */
export default function MyHandoverPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: boardWorkKeys.myHandover, queryFn: boardWorkFetchers.myHandover, enabled: allowed });
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const h = q.data?.handover ?? null;
  const draft = h?.status === 'draft' ? h : null;
  useEffect(() => {
    setNotes(draft?.notes ?? '');
  }, [draft?.id, draft?.notes]);
  const save = useAction(
    () => unwrap(api.PUT('/api/v1/staff/governance/handover', { body: { notes: notes.trim() || null } })),
    { invalidate: [boardWorkKeys.myHandover], onDone: () => toast.show(t('draftSaved')) },
  );
  const deliver = useAction(() => unwrap(api.POST('/api/v1/staff/governance/handover/deliver')), {
    invalidate: [boardWorkKeys.myHandover, boardWorkKeys.handovers],
    onDone: () => (setConfirming(false), toast.show(t('delivered'))),
  });
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
      <QueryState query={q}>
        {h?.status === 'delivered' ? <Alert tone="info">{t('lastDelivered', { when: f.dateTime(h.deliveredAt) })}</Alert> : null}
        <Card>
          <CardHeader title={draft ? t('yourDraft') : t('newHandover')} />
          <div className="stack">
            <Field label={t('notes')} hint={t('notesHint')} error={fieldError(save.error, 'notes')}>
              {(p) => <Textarea {...p} rows={10} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
            <ErrorAlert error={save.error ?? deliver.error} />
            <span className="toolbar">
              <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
                {t('saveDraft')}
              </Button>
              <Button variant="primary" disabled={!draft} onClick={() => setConfirming(true)}>
                {t('deliver')}
              </Button>
            </span>
          </div>
        </Card>
      </QueryState>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('deliverTitle')}
        description={t('deliverDescription')}
        confirmLabel={t('deliver')}
        pending={deliver.isPending}
        onConfirm={() => deliver.mutate(undefined)}
      />
    </>
  );
}
