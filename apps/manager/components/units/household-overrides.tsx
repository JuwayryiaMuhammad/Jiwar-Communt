'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Field, ReasonDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/units-household';
import en from '@/messages/en/units-household';
import { revocable } from './revocable';

type Member = Schema<'HouseholdMemberItemView'>;
type Permission = Schema<'RevokeByManagementDto'>['permission'];
const permissions = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).flatMap(([key, text]) => (key.startsWith('perm.') ? [[key.slice('perm.'.length), text]] : [])));
/** The words for a permission a primary gives, keyed by its code. */
const PERMISSION_LABELS = { en: permissions(en), ar: permissions(ar) };

/**
 * Management's decisions on a household (ADR 0021, `household.override`):
 * remove a member, or take back a permission the primary gave them. Meant
 * for a separation, when the residents may not settle it between
 * themselves; the member is told, with the text written here.
 */
export function MemberOverrides({ unitId, member }: { unitId: string; member: Member }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const permissionText = useLabel(PERMISSION_LABELS);
  const toast = useToast();
  const [open, setOpen] = useState<'remove' | 'revoke' | null>(null);
  const [permission, setPermission] = useState<Permission | ''>('');
  const name = member.fullName ?? t('thisMember');
  const refresh = [keys.unit(unitId)];
  const close = () => {
    setOpen(null);
    setPermission('');
    remove.reset();
    revoke.reset();
  };
  const remove = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/household/members/{id}/remove-by-management', { params: { path: { id: member.id } }, body: reason })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('removed', { name }));
        close();
      },
    },
  );
  const revoke = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/household/members/{id}/permissions/revoke-by-management', {
          params: { path: { id: member.id } },
          body: { ...reason, permission: permission as Permission },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('revoked', { name }));
        close();
      },
    },
  );
  if (member.status !== 'active') return null;
  // What the member holds, as the API tells a manager who reads residents;
  // without that, every permission is offered and the API refuses one they
  // do not hold.
  const { known, options } = revocable(member.grantedPermissions);
  const nothing = known && options.length === 0;

  return (
    <span className="row" style={{ justifyContent: 'flex-end' }}>
      <Button size="sm" disabled={nothing} title={nothing ? t('holdsNothing', { name }) : undefined} onClick={() => setOpen('revoke')}>
        {t('revokeAccess')}
      </Button>
      <Button size="sm" onClick={() => setOpen('remove')}>
        {c('remove')}
      </Button>
      <ReasonDialog
        open={open === 'remove'}
        onClose={close}
        title={t('removeTitle', { name })}
        description={t('removeDescription')}
        codes={REASON_CODES.memberRemovalByManagement}
        confirmLabel={t('removeConfirm')}
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={(reason) => remove.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'revoke'}
        onClose={close}
        title={t('revokeTitle', { name })}
        description={known ? t('revokeKnown') : t('revokeUnknown')}
        codes={REASON_CODES.permissionRevoke}
        confirmLabel={t('revokeConfirm')}
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(reason) => permission !== '' && revoke.mutate(reason)}
      >
        <Field label={t('whatToTakeBack')} error={permission === '' && revoke.isError ? c('reason.pickOne') : undefined}>
          {(p) => (
            <Select {...p} value={permission} onChange={(e) => setPermission(e.target.value as Permission | '')}>
              <option value="">{c('select')}</option>
              {options.map((g) => (
                <option key={g} value={g}>
                  {permissionText(g)}
                </option>
              ))}
              <option value="all">{t('perm.all')}</option>
            </Select>
          )}
        </Field>
      </ReasonDialog>
    </span>
  );
}
