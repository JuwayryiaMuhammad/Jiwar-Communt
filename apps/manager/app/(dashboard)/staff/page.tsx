'use client';

import { formatDate, humanize, unwrap } from '@jiwar/api';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Account } from '@/lib/queries';

type StaffType = 'staff' | 'manager';
type Filter = 'staff' | 'manager' | 'everyone';

function NewStaffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
        toast.show(`${a.fullName ?? 'Account'} created. They sign in with a code sent to their email.`);
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
      title="New staff account"
      description="Guards and other staff use the Jiwar app; another manager uses this dashboard."
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create account
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label="Account type">
            {(p) => (
              <Select
                {...p}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as StaffType);
                  setRoleKey('');
                }}
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
              </Select>
            )}
          </Field>
          <Field label="Role" hint="Empty: the default role of the type." error={fieldError(create.error, 'roleKey')}>
            {(p) => (
              <Select {...p} value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
                <option value="">Default</option>
                {options.map((r) => (
                  <option key={r.id} value={r.key}>
                    {r.name ?? humanize(r.key)}
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
        toast.show(a.status === 'active' ? `${a.fullName} can sign in again.` : `${a.fullName} can no longer sign in.`);
        setChanging(null);
      },
    },
  );

  return (
    <>
      <PageHeader
        title="Staff"
        description="Accounts that work for the compound: managers and staff such as guards."
        actions={
          <>
            <Segmented<Filter>
              label="Account type"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'staff', label: 'Staff' },
                { value: 'manager', label: 'Managers' },
                { value: 'everyone', label: 'All accounts' },
              ]}
            />
            <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              New account
            </Button>
          </>
        }
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Account>
            rows={rows}
            rowKey={(a) => a.id}
            empty={filter === 'staff' ? 'No staff accounts yet' : 'No accounts'}
            columns={[
              {
                key: 'name',
                header: 'Name',
                cell: (a) =>
                  a.erased ? (
                    <span className="t-secondary">Erased account</span>
                  ) : (
                    <span className="table__primary">
                      {a.fullName}
                      {a.id === me.data?.id ? <span className="t-secondary"> (you)</span> : null}
                    </span>
                  ),
              },
              { key: 'type', header: 'Type', cell: (a) => humanize(a.type) },
              {
                key: 'contact',
                header: 'Contact',
                cell: (a) =>
                  a.erased ? null : (
                    <div>
                      <div>{a.email}</div>
                      <div className="list__meta t-num">{a.phone ?? '—'}</div>
                    </div>
                  ),
              },
              { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.erased ? 'erased' : a.status} /> },
              { key: 'created', header: 'Since', cell: (a) => formatDate(a.createdAt) },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (a) =>
                  a.erased || a.id === me.data?.id || (a.status !== 'active' && a.status !== 'inactive') ? null : (
                    <Button size="sm" onClick={() => setChanging(a)}>
                      {a.status === 'active' ? 'Deactivate' : 'Activate'}
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
        title={changing?.status === 'active' ? `Deactivate ${changing.fullName}?` : `Activate ${changing?.fullName ?? ''}?`}
        description={
          changing?.status === 'active'
            ? 'They are signed out on their next request and cannot sign in.'
            : 'They can sign in again with a code sent to their email.'
        }
        confirmLabel={changing?.status === 'active' ? 'Deactivate' : 'Activate'}
        danger={changing?.status === 'active'}
        pending={setStatus.isPending}
        error={<ErrorAlert error={setStatus.error} />}
        onConfirm={() => changing && setStatus.mutate(changing)}
      />
    </>
  );
}
