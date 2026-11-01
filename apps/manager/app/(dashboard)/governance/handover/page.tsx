'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Button, Card, CardHeader, ConfirmDialog, Field, ForbiddenState, PageHeader, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';

/**
 * A manager's handover (ADR 0075): notes in their own words, delivered
 * once with a snapshot of what waits for the office. While a board sits,
 * a manager who delivered none cannot be deactivated unless the board
 * approved going without.
 */
export default function MyHandoverPage() {
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
    { invalidate: [boardWorkKeys.myHandover], onDone: () => toast.show('Saved as a draft.') },
  );
  const deliver = useAction(() => unwrap(api.POST('/api/v1/staff/governance/handover/deliver')), {
    invalidate: [boardWorkKeys.myHandover, boardWorkKeys.handovers],
    onDone: () => (setConfirming(false), toast.show('Delivered. The board and the other managers are told.')),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="My handover" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="My handover"
        description="Before you leave: what whoever comes next should know. Delivered once, with what waits for the office then."
      />
      <QueryState query={q}>
        {h?.status === 'delivered' ? (
          <Alert tone="info">Your last handover was delivered {h.deliveredAt ? formatDateTime(h.deliveredAt) : ''}. A new note starts a new draft.</Alert>
        ) : null}
        <Card>
          <CardHeader title={draft ? 'Your draft' : 'A new handover'} />
          <div className="stack">
            <Field label="Notes" hint="Write no resident’s name" error={fieldError(save.error, 'notes')}>
              {(p) => <Textarea {...p} rows={10} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
            <ErrorAlert error={save.error ?? deliver.error} />
            <span className="toolbar">
              <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
                Save the draft
              </Button>
              <Button variant="primary" disabled={!draft} onClick={() => setConfirming(true)}>
                Deliver
              </Button>
            </span>
          </div>
        </Card>
      </QueryState>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Deliver your handover?"
        description="It is kept as it is from then on, with a snapshot of what waits for the office now."
        confirmLabel="Deliver"
        pending={deliver.isPending}
        onConfirm={() => deliver.mutate(undefined)}
      />
    </>
  );
}
