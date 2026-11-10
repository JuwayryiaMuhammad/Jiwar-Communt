'use client';

import { unwrap } from '@jiwar/api';
import {
  emptyPerson,
  ErrorAlert,
  fieldError,
  LoadMore,
  PersonFields,
  personPayload,
  QueryState,
  useAction,
  useCursorList,
  type Person,
} from '@jiwar/api/react';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useFormat, useT } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Account } from '@/lib/queries';
import ar from '@/messages/ar/staff';
import en from '@/messages/en/staff';

type StaffType = 'staff' | 'manager';
type Filter = 'staff' | 'manager' | 'everyone';

function NewStaffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [person, setPerson] = useState<Person>(emptyPerson);
  const [type, setType] = useState<StaffType>('staff');
  const [roleKey, setRoleKey] = useState('');
  const roles = useQuery({ queryKey: keys.roles, queryFn: fetchers.roles });
  const options = (roles.data?.data ?? []).filter((r) => r.kind === type);

  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/accounts', {
          body: { ...personPayload(person, { locale: false }), type, ...(roleKey ? { roleKey } : {}) },
        }),
      ),
    {
      invalidate: [keys.accounts],
      onDone: (a) => {
        toast.show(t('created', { name: a.fullName ?? t('account') }));
        close();
      },
    },
  );
  function close() {
    setPerson(emptyPerson);
    setType('staff');
    setRoleKey('');
    create.reset();
    onClose();
  }
  return (
    <Dialog
      wide
      open={open}
      onClose={close}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            {t('createAccount')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label={t('accountType')}>
            {(p) => (
              <Select
                {...p}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as StaffType);
                  setRoleKey('');
                }}
              >
                <option value="staff">{t('staff')}</option>
                <option value="manager">{t('manager')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('role')} hint={t('roleHint')} error={fieldError(create.error, 'roleKey')}>
            {(p) => (
              <Select {...p} value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
                <option value="">{t('defaultRole')}</option>
                {options.map((r) => (
                  <option key={r.id} value={r.key}>
                    {r.name ?? label(r.key)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <PersonFields value={person} onChange={setPerson} error={create.error} locale={false} />
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

export default function StaffPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('staff');
  const [changing, setChanging] = useState<Account | null>(null);
  const list = useCursorList(keys.accounts, (c) => fetchers.accounts(c, 100));
  const me = useQuery({ queryKey: keys.me, queryFn: fetchers.me });

  const rows = useMemo(
    () => (list.rows ?? []).filter((a) => filter === 'everyone' || a.type === filter),
    [list.rows, filter],
  );

  const setStatus = useAction(
    (a: Account) =>
      unwrap(
        api.PATCH('/api/v1/accounts/{id}/status', {
          params: { path: { id: a.id } },
          body: { status: a.status === 'active' ? 'inactive' : 'active' },
        }),
      ),
    {
      invalidate: [keys.accounts],
      onDone: (a) => {
        toast.show(a.status === 'active' ? t('canSignIn', { name: a.fullName }) : t('cannotSignIn', { name: a.fullName }));
        setChanging(null);
      },
    },
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Segmented<Filter>
              label={t('accountType')}
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'staff', label: t('staff') },
                { value: 'manager', label: t('managers') },
                { value: 'everyone', label: t('everyone') },
              ]}
            />
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              {t('newAccount')}
            </Button>
          </>
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Account>
            rows={rows}
            rowKey={(a) => a.id}
            empty={filter === 'staff' ? t('emptyStaff') : t('empty')}
            columns={[
              {
                key: 'name',
                header: c('name'),
                cell: (a) =>
                  a.erased ? (
                    <span className="t-secondary">{t('erased')}</span>
                  ) : (
                    <span className="table__primary">
                      <Link className="table__link" href={`/accounts/${a.id}`}>
                        {a.fullName}
                      </Link>
                      {a.id === me.data?.id ? <span className="t-secondary">{t('you')}</span> : null}
                    </span>
                  ),
              },
              { key: 'type', header: c('type'), cell: (a) => label(a.type) },
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
              { key: 'status', header: c('status'), cell: (a) => <StatusBadge status={a.erased ? 'erased' : a.status} /> },
              { key: 'created', header: t('since'), cell: (a) => f.date(a.createdAt) },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (a) =>
                  a.erased || a.id === me.data?.id || (a.status !== 'active' && a.status !== 'inactive') ? null : (
                    <Button size="sm" onClick={() => setChanging(a)}>
                      {a.status === 'active' ? t('deactivate') : t('activate')}
                    </Button>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <NewStaffDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={changing !== null}
        onClose={() => {
          setChanging(null);
          setStatus.reset();
        }}
        title={
          changing?.status === 'active'
            ? t('deactivateTitle', { name: changing.fullName })
            : t('activateTitle', { name: changing?.fullName ?? '' })
        }
        description={
          changing?.status === 'active'
            ? t('deactivateDescription')
            : t('activateDescription')
        }
        confirmLabel={changing?.status === 'active' ? t('deactivate') : t('activate')}
        danger={changing?.status === 'active'}
        pending={setStatus.isPending}
        error={<ErrorAlert error={setStatus.error} />}
        onConfirm={() => changing && setStatus.mutate(changing)}
      />
    </>
  );
}
