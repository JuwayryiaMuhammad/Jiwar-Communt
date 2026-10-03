'use client';

import { humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { PERMISSION_TEXT } from '@/lib/labels';
import { fetchers, keys, type Role } from '@/lib/queries';

function group(key: string) {
  return key.split('.')[0] ?? key;
}

function RoleEditor({ role }: { role: Role }) {
  const toast = useToast();
  const permissions = useQuery({ queryKey: keys.permissions, queryFn: fetchers.permissions });
  // Seeded per role (the parent keys this by role id): a background refetch
  // must not wipe unsaved ticks.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role.permissions));

  const assignable = useMemo(
    () => (permissions.data?.data ?? []).filter((p) => p.kinds.includes(role.kind)),
    [permissions.data, role.kind],
  );
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of assignable) map.set(group(p.key), [...(map.get(group(p.key)) ?? []), p.key]);
    return [...map.entries()];
  }, [assignable]);

  const dirty =
    selected.size !== role.permissions.length || role.permissions.some((p) => !selected.has(p));

  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/roles/{id}/permissions', {
          params: { path: { id: role.id } },
          body: { permissions: [...selected].sort() },
        }),
      ),
    {
      invalidate: [keys.roles],
      onDone: () => toast.show(`${role.name ?? humanize(role.key)} saved. It applies on everyone's next request.`),
    },
  );

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  return (
    <Card flush>
      <CardHeader
        title={
          <span className="row">
            {role.name ?? humanize(role.key)}
            {role.isSystem ? <Badge tone="beige" plain>System</Badge> : null}
          </span>
        }
        actions={
          <>
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => setSelected(new Set(role.permissions))}>
              Undo
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save
            </Button>
          </>
        }
      >
        <span className="t-secondary">For {humanize(role.kind)} accounts.</span>
      </CardHeader>
      <CardBody>
        <QueryState query={permissions} rows={4}>
          <div className="stack">
            {role.key === 'manager' ? (
              <Alert tone="info">Some manager permissions can never be removed, so the compound always has someone who can manage it.</Alert>
            ) : null}
            {groups.map(([name, keysInGroup]) => (
              <div key={name} className="stack stack--sm">
                <span className="form__section">{humanize(name)}</span>
                <div className="grid grid--2" style={{ gap: 8 }}>
                  {keysInGroup.map((key) => (
                    <label key={key} className="perm">
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span>
                        <span className="table__primary" style={{ display: 'block' }}>
                          {PERMISSION_TEXT[key] ?? humanize(key)}
                        </span>
                        <span className="t-mono t-secondary">{key}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <ErrorAlert error={save.error} />
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

export default function RolesPage() {
  const roles = useQuery({ queryKey: keys.roles, queryFn: fetchers.roles });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = roles.data?.data ?? [];
  const selected = list.find((r) => r.id === selectedId) ?? list[0];

  return (
    <>
      <PageHeader title="Roles" description="What each kind of account may do in this compound. Changes apply immediately." />
      <QueryState query={roles}>
        {list.length ? (
          <div className="grid grid--main-aside" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2.4fr)' }}>
            <Card flush>
              <ul className="list">
                {list.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="list__item choice"
                      style={{
                        border: 'none',
                        borderRadius: 0,
                        background: r.id === selected?.id ? 'var(--color-accent-green-soft)' : undefined,
                      }}
                      aria-pressed={r.id === selected?.id}
                      onClick={() => setSelectedId(r.id)}
                    >
                      <span className="list__text">
                        <span className="list__title" style={{ display: 'block' }}>
                          {r.name ?? humanize(r.key)}
                        </span>
                        <span className="list__meta">
                          {humanize(r.kind)} · {r.permissions.length} permissions
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {selected ? <RoleEditor key={selected.id} role={selected} /> : null}
          </div>
        ) : (
          <EmptyState title="No roles" />
        )}
      </QueryState>
    </>
  );
}
