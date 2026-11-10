'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, ReasonDialog, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type LegalHold } from '@/lib/queries';
import ar from '@/messages/ar/shell-accounts';
import en from '@/messages/en/shell-accounts';

/**
 * Legal holds (ADR 0023): an obligation to keep the account's data. While
 * one is active the account cannot be erased; the person learns their
 * deletion is on hold, never why. The note is the manager's record.
 */
export function LegalHolds({ accountId }: { accountId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const key = keys.accountPart(accountId, 'legal-holds');
  const holds = useQuery({ queryKey: key, queryFn: () => fetchers.legalHolds(accountId) });
  const refresh = [key, keys.erasures];

  const place = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/accounts/{id}/legal-holds', { params: { path: { id: accountId } }, body: reason })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('hold.placed'));
        setPlacing(false);
      },
    },
  );
  const release = useAction(
    (v: { hold: LegalHold; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/legal-holds/{id}/release', {
          params: { path: { id: v.hold.id } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('hold.released'));
        setReleasing(null);
      },
    },
  );

  return (
    <Card flush>
      <CardHeader
        title={t('hold.title')}
        actions={
          <Button size="sm" onClick={() => setPlacing(true)}>
            {t('hold.place')}
          </Button>
        }
      />
      <QueryState query={holds} rows={2}>
        <DataTable<LegalHold>
          rows={holds.data?.data}
          rowKey={(h) => h.id}
          empty={t('hold.empty')}
          emptyHint={t('hold.emptyHint')}
          columns={[
            { key: 'reason', header: c('reason'), cell: (h) => label(h.reasonCode) },
            { key: 'placed', header: t('hold.col.placed'), cell: (h) => f.dateTime(h.placedAt) },
            {
              key: 'actions',
              header: <span className="visually-hidden">{c('actions')}</span>,
              className: 'table__actions',
              cell: (h) => (
                <Button size="sm" onClick={() => setReleasing(h)}>
                  {t('hold.release')}
                </Button>
              ),
            },
          ]}
        />
      </QueryState>
      <ReasonDialog
        open={placing}
        onClose={() => {
          setPlacing(false);
          place.reset();
        }}
        title={t('hold.placeTitle')}
        description={t('hold.placeDescription')}
        codes={REASON_CODES.legalHold}
        textLabel={t('hold.note')}
        textHint={t('hold.noteHint')}
        confirmLabel={t('hold.placeConfirm')}
        pending={place.isPending}
        error={<ErrorAlert error={place.error} />}
        onConfirm={(reason) => place.mutate(reason)}
      />
      <ReasonDialog
        open={releasing !== null}
        onClose={() => {
          setReleasing(null);
          release.reset();
        }}
        title={t('hold.releaseTitle')}
        description={t('hold.releaseDescription')}
        codes={REASON_CODES.legalHoldRelease}
        textLabel={t('hold.note')}
        textHint={t('hold.noteHint')}
        confirmLabel={t('hold.releaseConfirm')}
        pending={release.isPending}
        error={<ErrorAlert error={release.error} />}
        onConfirm={(reason) => releasing && release.mutate({ hold: releasing, ...reason })}
      />
    </Card>
  );
}
