'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, ForbiddenState, PageHeader } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { postName } from '@/components/security/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ChildAlert } from '@/lib/queries';

/** The guard by first name, as the alert carries them. */
const guardName = (g: ChildAlert['guard']) => (g.erased ? 'An erased account' : (g.firstName ?? '—'));

/** How the person was known, in the staff's words. */
const METHOD: Record<ChildAlert['method'], string> = {
  resident_qr: 'A resident’s entry QR',
  worker_qr: 'A worker’s card',
  worker_code: 'A worker’s code',
  pickup_qr: 'A pickup QR',
  pickup_code: 'A pickup code',
  alone: 'Alone',
  unidentified: 'Could not be identified',
};

function AlertDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const alert = useQuery({ queryKey: keys.childAlert(id), queryFn: () => fetchers.childAlert(id) });
  const a = alert.data;
  return (
    <Dialog open onClose={onClose} title="Unauthorized pickup" footer={<Button onClick={onClose}>Done</Button>}>
      <QueryState query={alert} rows={4}>
        {a ? (
          <dl className="dl">
            <dt>When</dt>
            <dd>{formatDateTime(a.at)}</dd>
            <dt>Post</dt>
            <dd>{postName(a.post)}</dd>
            <dt>Guard</dt>
            <dd>{guardName(a.guard)}</dd>
            <dt>Unit</dt>
            <dd>{a.unitCode}</dd>
            <dt>How the person was known</dt>
            <dd>
              {METHOD[a.method]}
              {a.escortKind ? <Badge tone="beige">{humanize(a.escortKind)} escort</Badge> : null}
            </dd>
            <dt>Why it was refused</dt>
            <dd>{a.refusalReason ? humanize(a.refusalReason) : '—'}</dd>
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
  const { ready, can } = usePermissions();
  const allowed = can('guard_roster.manage');
  const params = useSearchParams();
  const [open, setOpen] = useState<string | null>(params.get('open'));
  const list = useCursorList(keys.childAlerts, (c) => fetchers.childAlerts(c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Child alerts" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Child alerts"
        description="Someone tried to collect a child who may not go with them. The household and the keepers are told at once; kept 30 days."
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<ChildAlert>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty="No unauthorized pickup in the last 30 days"
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (a) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(a.id)}>
                    {formatDateTime(a.at)}
                  </Button>
                ),
              },
              { key: 'post', header: 'Post', cell: (a) => postName(a.post) },
              { key: 'unit', header: 'Unit', cell: (a) => a.unitCode },
              { key: 'how', header: 'How', cell: (a) => METHOD[a.method] },
              { key: 'why', header: 'Why', cell: (a) => (a.refusalReason ? humanize(a.refusalReason) : '—') },
              { key: 'guard', header: 'Guard', cell: (a) => guardName(a.guard) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <AlertDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
