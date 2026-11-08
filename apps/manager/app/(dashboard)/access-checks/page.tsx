'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

interface Ref {
  id: string;
  fullName?: string | null;
}
interface Finding {
  id: string;
  account: Ref;
  accountType: string;
  reason: string;
  lastActiveAt: string | null;
  foundAt: string;
  status: string;
}
interface Line {
  id: string;
  account: Ref;
  accountType: string;
  role: { key: string | null; name: string | null };
  permissions: string[];
  lastActiveAt: string | null;
  protected: boolean;
  decision: string | null;
}
interface Review {
  id: string;
  number: string;
  status: string;
  openedAt: string;
  lines: number;
  kept: number;
  revoked: number;
  left: number;
  undecided: number;
  reviewLines?: Line[];
}
interface Settings {
  idleDays: number;
  reviewEveryDays: number;
}

const name = (r: Ref) => r.fullName ?? 'Erased';
const list = <T,>(res: unknown) => (res as { data: T[] }).data;

/**
 * The account checks (ADR 0090): accounts of the compound's side that look
 * dangling, to keep or deactivate; and access reviews, each line kept or
 * revoked, revoked deactivating the account. `accounts.manage`.
 */
export default function AccessChecksPage() {
  const { ready, can, me } = usePermissions();
  const toast = useToast();
  const allowed = can('accounts.manage');
  const findings = useQuery({
    queryKey: ['access-checks', 'dangling'],
    queryFn: async () =>
      list<Finding>(await unwrap(api.GET('/api/v1/staff/access/dangling-accounts', { params: { query: { status: 'open' } } }))),
    enabled: allowed,
  });
  const reviews = useQuery({
    queryKey: ['access-checks', 'reviews'],
    queryFn: async () => list<Review>(await unwrap(api.GET('/api/v1/staff/access/reviews', {}))),
    enabled: allowed,
  });
  const openReview = reviews.data?.find((r) => r.status === 'open');
  const review = useQuery({
    queryKey: ['access-checks', 'review', openReview?.id],
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/staff/access/reviews/{id}', { params: { path: { id: openReview!.id } } }),
      )) as Review,
    enabled: allowed && !!openReview,
  });
  const settings = useQuery({
    queryKey: ['access-checks', 'settings'],
    queryFn: async () => (await unwrap(api.GET('/api/v1/staff/access/settings', {}))) as Settings,
    enabled: allowed,
  });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const save = useAction(
    () => unwrap(api.PATCH('/api/v1/staff/access/settings', { body: draft })),
    { invalidate: [['access-checks']], onDone: () => toast.show('Saved.') },
  );
  const keep = useAction(
    ({ id, reasonCode }: { id: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/access/dangling-accounts/{id}/keep', { params: { path: { id } }, body: { reasonCode } }),
      ),
    { invalidate: [['access-checks']], onDone: () => toast.show('Kept; not found again for 90 days.') },
  );
  const deactivate = useAction(
    (id: string) =>
      unwrap(api.POST('/api/v1/staff/access/dangling-accounts/{id}/deactivate', { params: { path: { id } } })),
    { invalidate: [['access-checks']], onDone: () => toast.show('Deactivated.') },
  );
  const open = useAction(() => unwrap(api.POST('/api/v1/staff/access/reviews', {})), {
    invalidate: [['access-checks']],
    onDone: () => toast.show('Review opened.'),
  });
  const decide = useAction(
    ({ lineId, decision }: { lineId: string; decision: 'keep' | 'revoke' }) =>
      unwrap(
        api.POST('/api/v1/staff/access/reviews/{id}/lines/{lineId}/decide', {
          params: { path: { id: openReview!.id, lineId } },
          body: { decision },
        }),
      ),
    { invalidate: [['access-checks']] },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Access checks" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Access checks"
        description="Staff, manager and contractor accounts that look dangling, and the periodic review of who has access."
      />
      <Card>
        <CardHeader title="Dangling accounts" />
        <ErrorAlert error={keep.error ?? deactivate.error} />
        <QueryState query={findings}>
          <DataTable<Finding>
            rows={findings.data ?? []}
            rowKey={(r) => r.id}
            empty="No account looks dangling"
            columns={[
              { key: 'a', header: 'Account', cell: (r) => `${name(r.account)} (${r.accountType})` },
              { key: 'r', header: 'Why', cell: (r) => humanize(r.reason) },
              { key: 'l', header: 'Last sign-in', cell: (r) => (r.lastActiveAt ? formatDateTime(r.lastActiveAt) : 'Never') },
              { key: 'f', header: 'Found', cell: (r) => formatDateTime(r.foundAt) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (r) =>
                  r.account.id === me?.id ? null : (
                    <span className="row" style={{ gap: 6 }}>
                      <Select
                        aria-label="Keep, with a reason"
                        value=""
                        onChange={(e) => e.target.value && keep.mutate({ id: r.id, reasonCode: e.target.value })}
                      >
                        <option value="">Keep…</option>
                        {REASON_CODES.danglingKeep.map((c) => (
                          <option key={c} value={c}>
                            {humanize(c)}
                          </option>
                        ))}
                      </Select>
                      <Button size="sm" variant="danger" loading={deactivate.isPending} onClick={() => deactivate.mutate(r.id)}>
                        Deactivate
                      </Button>
                    </span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>

      <Card>
        <CardHeader title={openReview ? `Access review ${openReview.number}` : 'Access review'} />
        <CardBody>
          {openReview ? (
            <p>
              Opened {formatDateTime(openReview.openedAt)}: {openReview.undecided} of {openReview.lines} lines to decide.
              Revoking deactivates the account at once.
            </p>
          ) : (
            <Button variant="primary" loading={open.isPending} onClick={() => open.mutate()}>
              Open a review now
            </Button>
          )}
          <ErrorAlert error={open.error ?? decide.error} />
        </CardBody>
        {openReview ? (
          <QueryState query={review}>
            <DataTable<Line>
              rows={review.data?.reviewLines ?? []}
              rowKey={(r) => r.id}
              empty="Nobody to review"
              columns={[
                { key: 'a', header: 'Account', cell: (r) => `${name(r.account)} (${r.accountType})` },
                { key: 'r', header: 'Role', cell: (r) => (r.role.key ? humanize(r.role.key) : (r.role.name ?? '—')) },
                { key: 'p', header: 'Permissions', cell: (r) => r.permissions.length },
                { key: 'l', header: 'Last sign-in', cell: (r) => (r.lastActiveAt ? formatDateTime(r.lastActiveAt) : 'Never') },
                {
                  key: 'd',
                  header: 'Decision',
                  cell: (r) =>
                    r.decision ? (
                      humanize(r.decision)
                    ) : r.account.id === me?.id ? (
                      'Someone else decides'
                    ) : (
                      <span className="row" style={{ gap: 6 }}>
                        <Button size="sm" loading={decide.isPending} onClick={() => decide.mutate({ lineId: r.id, decision: 'keep' })}>
                          Keep
                        </Button>
                        {r.protected ? null : (
                          <Button
                            size="sm"
                            variant="danger"
                            loading={decide.isPending}
                            onClick={() => decide.mutate({ lineId: r.id, decision: 'revoke' })}
                          >
                            Revoke
                          </Button>
                        )}
                      </span>
                    ),
                },
              ]}
            />
          </QueryState>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Settings" />
        <CardBody>
          <QueryState query={settings}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Idle days (14–365)">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={14}
                    max={365}
                    value={draft.idleDays ?? settings.data?.idleDays ?? ''}
                    onChange={(e) => setDraft({ ...draft, idleDays: Number(e.target.value) })}
                  />
                )}
              </Field>
              <Field label="A review every (days, 30–365)">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={30}
                    max={365}
                    value={draft.reviewEveryDays ?? settings.data?.reviewEveryDays ?? ''}
                    onChange={(e) => setDraft({ ...draft, reviewEveryDays: Number(e.target.value) })}
                  />
                )}
              </Field>
              <Button variant="primary" disabled={!Object.keys(draft).length} loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
            </div>
            <ErrorAlert error={save.error} />
          </QueryState>
        </CardBody>
      </Card>
    </>
  );
}
