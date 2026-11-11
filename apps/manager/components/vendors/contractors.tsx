'use client';

import { unwrap } from '@jiwar/api';
import {
  emptyPerson,
  ErrorAlert,
  LoadMore,
  PersonFields,
  personPayload,
  QueryState,
  useAction,
  useCursorList,
  type Person,
} from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, ConfirmDialog, DataTable, Dialog, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { SectionHeader } from '@/components/community/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Account, type Vendor } from '@/lib/queries';
import ar from '@/messages/ar/ops-vendor-contractors';
import en from '@/messages/en/ops-vendor-contractors';

function InviteDialog({ vendor, open, onClose }: { vendor: Vendor; open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [person, setPerson] = useState<Person>(emptyPerson);
  const invite = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/vendors/{id}/contractors', {
          params: { path: { id: vendor.id } },
          body: personPayload(person, { locale: false }),
        }),
      ),
    {
      invalidate: [keys.vendorContractors(vendor.id), keys.accounts],
      onDone: (a) => {
        toast.show(t('invited', { name: a.fullName ?? t('contractor'), vendor: vendor.name }));
        close();
      },
    },
  );
  function close() {
    setPerson(emptyPerson);
    invite.reset();
    onClose();
  }
  return (
    <Dialog
      wide
      open={open}
      onClose={close}
      title={t('inviteTitle', { vendor: vendor.name })}
      description={t('inviteDescription')}
      onSubmit={() => invite.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={invite.isPending}>
            {t('invite')}
          </Button>
        </>
      }
    >
      <div className="form">
        <PersonFields value={person} onChange={setPerson} error={invite.error} locale={false} />
        <ErrorAlert error={invite.error} />
      </div>
    </Dialog>
  );
}

/**
 * A vendor's contractor accounts (ADR 0088): the people who sign in for the
 * company, take the tickets dispatch offers it and bid on its tenders. Invited
 * with `vendors.manage` (a suspended vendor takes none); an account is
 * switched off, or on again, with `accounts.manage`.
 */
export function VendorContractors({ vendor }: { vendor: Vendor }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { can } = usePermissions();
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState<Account | null>(null);
  const list = useCursorList(keys.vendorContractors(vendor.id), (cursor) => fetchers.vendorContractors(vendor.id, cursor, 50));
  const setStatus = useAction(
    (a: Account) =>
      unwrap(
        api.PATCH('/api/v1/accounts/{id}/status', {
          params: { path: { id: a.id } },
          body: { status: a.status === 'active' ? 'inactive' : 'active' },
        }),
      ),
    {
      invalidate: [keys.vendorContractors(vendor.id), keys.accounts],
      onDone: (a) => {
        toast.show(a.status === 'active' ? t('canSignIn', { name: a.fullName }) : t('cannotSignIn', { name: a.fullName }));
        setChanging(null);
      },
    },
  );
  return (
    <Card flush>
      <SectionHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button
            variant="primary"
            icon={<Plus aria-hidden />}
            disabled={vendor.status !== 'active'}
            title={vendor.status !== 'active' ? t('suspendedHint') : undefined}
            onClick={() => setInviting(true)}
          >
            {t('invite')}
          </Button>
        }
      />
      <QueryState query={list}>
        <DataTable<Account>
          rows={list.rows ?? []}
          rowKey={(a) => a.id}
          empty={t('none')}
          columns={[
            {
              key: 'name',
              header: c('name'),
              cell: (a) => (a.erased ? <span className="t-secondary">{t('erased')}</span> : a.fullName),
            },
            {
              key: 'contact',
              header: t('contact'),
              cell: (a) =>
                a.erased ? null : (
                  <div>
                    <div className="ltr">{a.email}</div>
                    <div className="list__meta t-num ltr">{a.phone ?? '—'}</div>
                  </div>
                ),
            },
            { key: 'status', header: c('status'), cell: (a) => <StatusBadge status={a.erased ? 'erased' : (a.status ?? 'inactive')} /> },
            { key: 'since', header: t('since'), cell: (a) => (a.createdAt ? f.date(a.createdAt) : '—') },
            {
              key: 'actions',
              header: <span className="visually-hidden">{c('actions')}</span>,
              className: 'table__actions',
              cell: (a) =>
                !can('accounts.manage') || a.erased || (a.status !== 'active' && a.status !== 'inactive') ? null : (
                  <Button size="sm" onClick={() => setChanging(a)}>
                    {a.status === 'active' ? t('deactivate') : t('activate')}
                  </Button>
                ),
            },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
      <InviteDialog vendor={vendor} open={inviting} onClose={() => setInviting(false)} />
      <ConfirmDialog
        open={changing !== null}
        onClose={() => {
          setChanging(null);
          setStatus.reset();
        }}
        title={
          changing?.status === 'active'
            ? t('deactivateTitle', { name: changing.fullName ?? '' })
            : t('activateTitle', { name: changing?.fullName ?? '' })
        }
        description={changing?.status === 'active' ? t('deactivateDescription') : t('activateDescription')}
        confirmLabel={changing?.status === 'active' ? t('deactivate') : t('activate')}
        danger={changing?.status === 'active'}
        pending={setStatus.isPending}
        error={<ErrorAlert error={setStatus.error} />}
        onConfirm={() => changing && setStatus.mutate(changing)}
      />
    </Card>
  );
}
