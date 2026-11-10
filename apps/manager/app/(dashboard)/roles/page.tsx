'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Role } from '@/lib/queries';
import ar from '@/messages/ar/res-roles';
import en from '@/messages/en/res-roles';

/** The catalog's entries under one prefix (`perm.`, `group.`), keyed by what follows it. */
const withPrefix = (m: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(m).flatMap(([key, text]) => (key.startsWith(prefix) ? [[key.slice(prefix.length), text]] : [])));
/** The words for a permission, keyed by its code (`units.read`). */
const PERMISSION_LABELS = { en: withPrefix(en, 'perm.'), ar: withPrefix(ar, 'perm.') };
/** The words for a group of permissions, keyed by the first part of their codes (`units`). */
const GROUP_LABELS = { en: withPrefix(en, 'group.'), ar: withPrefix(ar, 'group.') };

function group(key: string) {
  return key.split('.')[0] ?? key;
}

function RoleEditor({ role }: { role: Role }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const permissionText = useLabel(PERMISSION_LABELS);
  const groupText = useLabel(GROUP_LABELS);
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
      onDone: () => toast.show(t('saved', { name: role.name ?? label(role.key) })),
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
            {role.name ?? label(role.key)}
            {role.isSystem ? <Badge tone="beige" plain>{t('system')}</Badge> : null}
          </span>
        }
        actions={
          <>
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => setSelected(new Set(role.permissions))}>
              {t('undo')}
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              {c('save')}
            </Button>
          </>
        }
      >
        <span className="t-secondary">{t('forKind', { kind: label(role.kind) })}</span>
      </CardHeader>
      <CardBody>
        <QueryState query={permissions} rows={4}>
          <div className="stack">
            {role.key === 'manager' ? <Alert tone="info">{t('managerNote')}</Alert> : null}
            {groups.map(([name, keysInGroup]) => (
              <div key={name} className="stack stack--sm">
                <span className="form__section">{groupText(name)}</span>
                <div className="grid grid--2" style={{ gap: 8 }}>
                  {keysInGroup.map((key) => (
                    <label key={key} className="perm">
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span>
                        <span className="table__primary" style={{ display: 'block' }}>
                          {permissionText(key)}
                        </span>
                        <span className="t-mono t-secondary ltr">{key}</span>
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
  const t = useT(en, ar);
  const label = useLabel();
  const roles = useQuery({ queryKey: keys.roles, queryFn: fetchers.roles });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = roles.data?.data ?? [];
  const selected = list.find((r) => r.id === selectedId) ?? list[0];

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
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
                          {r.name ?? label(r.key)}
                        </span>
                        <span className="list__meta">{t('permissionCount', { kind: label(r.kind), n: r.permissions.length })}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {selected ? <RoleEditor key={selected.id} role={selected} /> : null}
          </div>
        ) : (
          <EmptyState title={t('noRoles')} />
        )}
      </QueryState>
    </>
  );
}
