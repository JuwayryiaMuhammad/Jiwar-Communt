'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { Field, Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

/**
 * The treasury's account a payout leaves (ADR 0085, 0089): a cash box for
 * cash, a bank account for a transfer or a cheque. Listing them needs
 * `finance.treasury`; without it the payout is refused for want of one.
 */
export function PayoutAccountField({
  method,
  value,
  onChange,
  error,
}: {
  method: 'bank_transfer' | 'cheque' | 'cash';
  value: string;
  onChange: (id: string) => void;
  error?: unknown;
}) {
  const { can } = usePermissions();
  const allowed = can('finance.treasury');
  const accounts = useQuery({
    queryKey: ['finance', 'cash-accounts'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/finance/cash-accounts')),
    enabled: allowed,
  });
  const kind = method === 'cash' ? 'cash' : 'bank';
  return (
    <Field
      label={kind === 'cash' ? 'From the cash box' : 'From the bank account'}
      error={fieldError(error, 'cashAccountId')}
      hint={allowed ? undefined : 'Choosing an account needs the treasury permission.'}
    >
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value)} disabled={!allowed}>
          <option value="">{kind === 'cash' ? 'Choose a cash box…' : 'Choose a bank account…'}</option>
          {accounts.data?.data
            .filter((a) => a.kind === kind)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.balance} EGP
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
}
