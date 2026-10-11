'use client';

import { humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Field, ReasonDialog, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

type Member = Schema<'HouseholdMemberItemView'>;
type Permission = Schema<'RevokeByManagementDto'>['permission'];
const ALL = ['visitors_invite', 'bookings', 'tickets', 'finance', 'unit_security'] as const;
const PERMISSION_TEXT: Record<string, string> = {
  visitors_invite: 'Invite visitors',
  bookings: 'Bookings',
  tickets: 'Maintenance tickets',
  finance: 'Payments',
  unit_security: 'Unit security',
  all: 'Everything they were given',
};

/**
 * Management's decisions on a household (ADR 0021, `household.override`):
 * remove a member, or take back a permission the primary gave them. Meant
 * for a separation, when the residents may not settle it between
 * themselves; the member is told, with the text written here.
 */
export function MemberOverrides({ unitId, member }: { unitId: string; member: Member }) {
  const toast = useToast();
  const [open, setOpen] = useState<'remove' | 'revoke' | null>(null);
  const [permission, setPermission] = useState<Permission | ''>('');
  const name = member.fullName ?? 'this member';
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
        toast.show(`${name} is removed from the household.`);
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
        toast.show(`Taken back from ${name}.`);
        close();
      },
    },
  );
  if (member.status !== 'active') return null;
  // The API shows a member's permissions to the unit's primary, not to
  // management: every permission is offered, and one the member does not
  // hold is refused with a plain message.
  const granted = member.permissions?.map((g) => g.permission) ?? ALL;

  return (
    <span className="row" style={{ justifyContent: 'flex-end' }}>
      <Button size="sm" onClick={() => setOpen('revoke')}>
        Revoke access
      </Button>
      <Button size="sm" onClick={() => setOpen('remove')}>
        Remove
      </Button>
      <ReasonDialog
        open={open === 'remove'}
        onClose={close}
        title={`Remove ${name} from the household?`}
        description="They lose their place in this unit's household and everything it gave them. They are told, with your message. The primary resident can invite them again."
        codes={REASON_CODES.memberRemovalByManagement}
        confirmLabel="Remove member"
        danger
        pending={remove.isPending}
        error={<ErrorAlert error={remove.error} />}
        onConfirm={(reason) => remove.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'revoke'}
        onClose={close}
        title={`Take back access from ${name}?`}
        description="They keep their place in the household and lose what you pick. They are told, with your message. What the primary gave them is not shown to management, so a permission they do not hold is simply refused."
        codes={REASON_CODES.permissionRevoke}
        confirmLabel="Revoke"
        pending={revoke.isPending}
        error={<ErrorAlert error={revoke.error} />}
        onConfirm={(reason) => permission !== '' && revoke.mutate(reason)}
      >
        <Field label="What to take back" error={permission === '' && revoke.isError ? 'Pick one.' : undefined}>
          {(p) => (
            <Select {...p} value={permission} onChange={(e) => setPermission(e.target.value as Permission | '')}>
              <option value="">Select…</option>
              {granted.map((g) => (
                <option key={g} value={g}>
                  {PERMISSION_TEXT[g] ?? humanize(g)}
                </option>
              ))}
              <option value="all">{PERMISSION_TEXT.all}</option>
            </Select>
          )}
        </Field>
      </ReasonDialog>
    </span>
  );
}
