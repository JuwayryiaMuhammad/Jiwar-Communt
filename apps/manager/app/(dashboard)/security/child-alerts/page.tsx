'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT, type Translate } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, ForbiddenState, PageHeader, useCommonT, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { postNameIn } from '@/components/security/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ChildAlert } from '@/lib/queries';
import ar from '@/messages/ar/sec-child-alerts';
import en from '@/messages/en/sec-child-alerts';

type T = Translate<typeof en>;

/** The guard by first name, as the alert carries them. */
const guardName = (t: T, g: ChildAlert['guard']) => (g.erased ? t('erasedAccount') : (g.firstName ?? '—'));

/** How the person was known, in the staff's words. */
const methodText = (t: T, m: ChildAlert['method']) => t(`method.${m}`);

function AlertDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const alert = useQuery({ queryKey: keys.childAlert(id), queryFn: () => fetchers.childAlert(id) });
  const a = alert.data;
  return (
    <Dialog open onClose={onClose} title={t('detailTitle')} footer={<Button onClick={onClose}>{c('close')}</Button>}>
      <QueryState query={alert} rows={4}>
        {a ? (
          <dl className="dl">
            <dt>{t('col.when')}</dt>
            <dd>{f.dateTime(a.at)}</dd>
            <dt>{t('col.post')}</dt>
            <dd>{postNameIn(a.post, locale)}</dd>
            <dt>{t('col.guard')}</dt>
            <dd>{guardName(t, a.guard)}</dd>
            <dt>{t('col.unit')}</dt>
            <dd>{a.unitCode}</dd>
            <dt>{t('howKnown')}</dt>
            <dd>
              {methodText(t, a.method)}
              {a.escortKind ? <Badge tone="beige">{t('escort', { kind: label(a.escortKind) })}</Badge> : null}
            </dd>
            <dt>{t('whyRefused')}</dt>
            <dd>{a.refusalReason ? label(a.refusalReason) : '—'}</dd>
          </dl>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/**
 * Unauthorized child pickups (ADR 0054), for the roster's keepers: when,
 * where, which guard, which unit, how the person was known. Never the
 * child: the household reads its own records in the app.
 */
export default function ChildAlertsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('guard_roster.manage');
  const params = useSearchParams();
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const list = useCursorList(keys.childAlerts, (c) => fetchers.childAlerts(c), { enabled: allowed });
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
      <Card flush>
        <QueryState query={list}>
          <DataTable<ChildAlert>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={t('empty')}
            columns={[
              {
                key: 'when',
                header: t('col.when'),
                cell: (a) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(a.id)}>
                    {f.dateTime(a.at)}
                  </Button>
                ),
              },
              { key: 'post', header: t('col.post'), cell: (a) => postNameIn(a.post, locale) },
              { key: 'unit', header: t('col.unit'), cell: (a) => a.unitCode },
              { key: 'how', header: t('col.how'), cell: (a) => methodText(t, a.method) },
              { key: 'why', header: t('col.why'), cell: (a) => (a.refusalReason ? label(a.refusalReason) : '—') },
              { key: 'guard', header: t('col.guard'), cell: (a) => guardName(t, a.guard) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <AlertDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
