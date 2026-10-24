'use client';

import { fieldError, formatDate, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type LateNotice } from '@/lib/queries';

const CURE = { min: 0, max: 60 };

/** How many of the notice's recipients have each proof. */
function proofs(n: LateNotice): string {
  const all = n.recipients.length;
  const emailed = n.recipients.filter((r) => r.emailedAt).length;
  const read = n.recipients.filter((r) => r.readAt).length;
  return `${all} delivered · ${emailed} emailed · ${read} read`;
}

function CurePeriod() {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.noticeSettings, queryFn: fetchers.noticeSettings });
  const [days, setDays] = useState('');
  useEffect(() => {
    if (settings.data) setDays(String(settings.data.lateNoticeCureDays));
  }, [settings.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/finance/notice-settings', {
          body: { lateNoticeCureDays: Number(days) },
        }),
      ),
    { invalidate: [keys.noticeSettings], onDone: () => toast.show('Cure period saved.') },
  );
  const n = Number(days);
  const valid = days !== '' && Number.isInteger(n) && n >= CURE.min && n <= CURE.max;
  return (
    <Card>
      <CardHeader title="Cure period" />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field
              label="Days after the due date"
              hint="An invoice still owed this many days after its due date, not disputed and not in a plan, gets one formal notice."
              error={fieldError(save.error, 'lateNoticeCureDays') ?? (days !== '' && !valid ? `A whole number from ${CURE.min} to ${CURE.max}.` : undefined)}
            >
              {(p) => <Input {...p} type="number" min={CURE.min} max={CURE.max} step={1} value={days} onChange={(e) => setDays(e.target.value)} />}
            </Field>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
                Save
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

/**
 * Formal late-payment notices (ADR 0058): one per overdue invoice after the
 * cure period, to the unit's finance holders, each with its proofs of
 * delivery, of the email and of the first reading.
 */
export default function LateNoticesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const list = useCursorList(keys.lateNotices, (c) => fetchers.lateNotices(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Late notices" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Late notices"
        description="Formal notices of late payment, the compound’s record: who got each, and the proof they did and read it."
      />
      <div className="stack">
        <CurePeriod />
        <Card flush>
          <QueryState query={list}>
            <DataTable<LateNotice>
              rows={list.rows}
              rowKey={(n) => n.id}
              empty="No notice yet"
              columns={[
                { key: 'n', header: 'Notice', cell: (n) => <span className="t-mono">{n.number}</span> },
                { key: 'a', header: 'Owed', cell: (n) => `${n.amount} EGP` },
                { key: 'd', header: 'Due', cell: (n) => formatDate(n.dueOn) },
                { key: 'i', header: 'Issued', cell: (n) => formatDateTime(n.issuedAt) },
                { key: 'p', header: 'Proofs', cell: (n) => proofs(n) },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
      </div>
    </>
  );
}
