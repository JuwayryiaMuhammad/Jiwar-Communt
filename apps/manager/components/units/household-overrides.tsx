'use client';

import { humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Field, ReasonDialog, Select, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { revocable } from './revocable';

type Member = Schema<'HouseholdMemberItemView'>;
type Permission = Schema<'RevokeByManagementDto'>['permission'];
const PERMISSION_TEXT: Record<string, string> = {
  visitors_invite: 'Invite visitors',
  bookings: 'Bookings',
  tickets: 'Maintenance tickets',
  finance: 'Payments',
  unit_security: 'Unit security',
  polls_vote: 'Voting in polls',
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
  // What the member holds, as the API tells a manager who reads residents;
  // without that, every permission is offered and the API refuses one they
  // do not hold.
  const { known, options } = revocable(member.grantedPermissions);
  const nothing = known && options.length === 0;

  return (
    <span className="row" style={{ justifyContent: 'flex-end' }}>
      <Button
        size="sm"
        disabled={nothing}
        title={nothing ? `${name} holds no permission in this household.` : undefined}
        onClick={() => setOpen('revoke')}
      >
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
        description={
          known
            ? 'They keep their place in the household and lose what you pick, from what they hold now. They are told, with your message.'
            : 'They keep their place in the household and lose what you pick. They are told, with your message. Your role does not show what they hold, so a permission they do not hold is simply refused.'
        }
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
              {options.map((g) => (
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
