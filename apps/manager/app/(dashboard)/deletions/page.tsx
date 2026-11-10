'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, PageHeader, ReasonCodeDialog, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EraseDialog } from '@/components/accounts/erase-dialog';
import { blockerText } from '@/components/accounts/labels';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Erasure } from '@/lib/queries';
import ar from '@/messages/ar/deletions';
import en from '@/messages/en/deletions';
import accountsAr from '@/messages/ar/shell-accounts';
import accountsEn from '@/messages/en/shell-accounts';

/**
 * Accounts that asked to be deleted (ADR 0023, 0036). A request cools off
 * for 14 days, then the system erases the account by itself unless
 * something blocks it; a blocked one waits here for a manager to clear the
 * blocker and erase, or to close the request.
 */
export default function DeletionsPage() {
  const t = useT(en, ar);
  const accounts = useT(accountsEn, accountsAr);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const { can } = usePermissions();
  const [erasing, setErasing] = useState<Erasure | null>(null);
  const [closing, setClosing] = useState<Erasure | null>(null);
  const list = useCursorList(keys.erasures, (c) => fetchers.erasures(c), { refetchInterval: 120_000 });
  const rows = list.rows ?? [];

  // The queue names accounts by id; their names come from each account, for a role that may read them.
  const names = useQueries({
    queries: rows.map((e) => ({
      queryKey: keys.account(e.accountId),
      queryFn: () => fetchers.account(e.accountId),
      enabled: can('accounts.read'),
      staleTime: 300_000,
    })),
  });
  const nameOf = (e: Erasure) => {
    const account = names[rows.indexOf(e)]?.data;
    return account?.fullName ?? t('thisPerson');
  };

  const close = useAction(
    (v: { e: Erasure; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/erasures/{id}/close', { params: { path: { id: v.e.id } }, body: { reasonCode: v.reasonCode } })),
    {
      invalidate: [keys.erasures],
      onDone: () => {
        toast.show(t('closedToast'));
        setClosing(null);
      },
    },
  );

  const now = Date.now();
  const ready = (e: Erasure) => e.status === 'queued' || new Date(e.effectiveAt).getTime() <= now;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Erasure>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'account',
                header: t('account'),
                cell: (e) =>
                  can('accounts.read') ? (
                    <Link className="table__link" href={`/accounts/${e.accountId}`}>
                      {nameOf(e)}
                    </Link>
                  ) : (
                    <span className="t-mono ltr">{e.accountId.slice(0, 8)}</span>
                  ),
              },
              {
                key: 'status',
                header: c('status'),
                cell: (e) =>
                  e.status === 'queued' ? (
                    <Badge tone="terracotta">{t('waiting')}</Badge>
                  ) : ready(e) ? (
                    <Badge tone="beige">{t('due')}</Badge>
                  ) : (
                    <Badge tone="beige">{t('coolingOff')}</Badge>
                  ),
              },
              {
                key: 'when',
                header: t('coolingEnds'),
                cell: (e) => (
                  <span title={t('askedOn', { when: f.dateTime(e.requestedAt) })} style={{ whiteSpace: 'nowrap' }}>
                    {f.date(e.effectiveAt)}
                    {e.daysOverdue > 0 ? <span className="t-secondary"> · {t('daysAgo', { days: e.daysOverdue })}</span> : null}
                  </span>
                ),
              },
              { key: 'by', header: t('askedBy'), cell: (e) => (e.assisted ? t('byManagement') : t('byPerson')) },
              {
                key: 'blockers',
                header: t('blocks'),
                cell: (e) => {
                  const all = [...new Set([...e.blockers, ...(e.onLegalHold ? ['legal_hold'] : [])])];
                  return all.length ? (
                    <ul style={{ margin: 0, paddingInlineStart: 16 }}>
                      {all.map((b) => (
                        <li key={b}>{blockerText(accounts, label, b)}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="t-secondary">{t('nothingKnown')}</span>
                  );
                },
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (e) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    {ready(e) ? (
                      <Button size="sm" variant="danger" onClick={() => setErasing(e)}>
                        {t('erase')}
                      </Button>
                    ) : null}
                    {e.status === 'queued' ? (
                      <Button size="sm" onClick={() => setClosing(e)}>
                        {t('closeRequest')}
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {erasing ? <EraseDialog erasure={erasing} name={nameOf(erasing)} onClose={() => setErasing(null)} /> : null}
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => {
          setClosing(null);
          close.reset();
        }}
        title={closing ? t('closeTitle', { name: nameOf(closing) }) : ''}
        description={t('closeDescription')}
        codes={REASON_CODES.deletionClose}
        confirmLabel={t('closeRequest')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reasonCode) => closing && close.mutate({ e: closing, reasonCode })}
      />
    </>
  );
}
