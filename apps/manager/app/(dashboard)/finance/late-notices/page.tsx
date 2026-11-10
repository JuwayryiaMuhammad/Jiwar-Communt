'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT, type Format, type Translate } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type LateNotice } from '@/lib/queries';
import ar from '@/messages/ar/fin-late-notices';
import en from '@/messages/en/fin-late-notices';

const CURE = { min: 0, max: 60 };

/** How many of the notice's recipients have each proof. */
function proofs(t: Translate<typeof en>, f: Format, n: LateNotice): string {
  const all = n.recipients.length;
  const emailed = n.recipients.filter((r) => r.emailedAt).length;
  const read = n.recipients.filter((r) => r.readAt).length;
  return t('proofLine', { all: f.number(all), emailed: f.number(emailed), read: f.number(read) });
}

function CurePeriod() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
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
    { invalidate: [keys.noticeSettings], onDone: () => toast.show(t('cure.saved')) },
  );
  const n = Number(days);
  const valid = days !== '' && Number.isInteger(n) && n >= CURE.min && n <= CURE.max;
  return (
    <Card>
      <CardHeader title={t('cure.title')} />
      <CardBody>
        <QueryState query={settings}>
          <div className="form">
            <Field
              label={t('cure.label')}
              hint={t('cure.hint')}
              error={
                fieldError(save.error, 'lateNoticeCureDays') ??
                (days !== '' && !valid ? t('cure.invalid', { min: f.number(CURE.min), max: f.number(CURE.max) }) : undefined)
              }
            >
              {(p) => <Input {...p} type="number" min={CURE.min} max={CURE.max} step={1} value={days} onChange={(e) => setDays(e.target.value)} />}
            </Field>
            <div>
              <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined)}>
                {c('save')}
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
  const t = useT(en, ar);
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('finance.invoice');
  const list = useCursorList(keys.lateNotices, (cursor) => fetchers.lateNotices(cursor), { enabled: allowed });
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
      <div className="stack">
        <CurePeriod />
        <Card flush>
          <QueryState query={list}>
            <DataTable<LateNotice>
              rows={list.rows}
              rowKey={(n) => n.id}
              empty={t('empty')}
              columns={[
                { key: 'n', header: t('notice'), cell: (n) => <span className="t-mono ltr">{n.number}</span> },
                { key: 'a', header: t('owed'), cell: (n) => f.money(n.amount) },
                { key: 'd', header: t('due'), cell: (n) => f.day(n.dueOn) },
                { key: 'i', header: t('issued'), cell: (n) => f.dateTime(n.issuedAt) },
                { key: 'p', header: t('proofs'), cell: (n) => proofs(t, f, n) },
              ]}
            />
            <LoadMore query={list} />
          </QueryState>
        </Card>
      </div>
    </>
  );
}
