import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { day } from '../setup/compound-clock';
import { glAccountId, glManualEntryRow } from '../setup/gl-rows';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of the general ledger (ADR 0092), in
 * A, as its manager. A pending entry to decide is written raw by another
 * of A's accounts: its maker never decides it.
 */
export function glCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: object,
  ) =>
    call(world(), method, path, {
      token: world().a.tokens.manager,
      ...(body ? { body } : {}),
    });
  const inA = <T>(fn: Parameters<TenantTx['withTenantTx']>[0]) =>
    world().helpers.asManager(world().a, () =>
      world().h.moduleRef.get(TenantTx).withTenantTx(fn),
    ) as Promise<T>;
  const suspense = () =>
    inA<string>((tx) => glAccountId(tx, world().a.tenantId, 'suspense'));
  const pending = () =>
    inA<string>((tx) =>
      glManualEntryRow(tx, {
        tenantId: world().a.tenantId,
        createdById: world().a.ids.supervisor,
      }),
    );
  let code = 100 + (Date.now() % 800);
  const subAccount = async () =>
    (
      (
        await as('POST', '/staff/finance/gl/accounts', {
          parentId: await suspense(),
          code: `1900.${++code}`,
          nameEn: 'Sub-account',
          nameAr: 'حساب فرعي',
        })
      ).body as { id: string }
    ).id;
  const period = `from=${day(0)}&to=${day(0)}`;
  return {
    'GET /staff/finance/gl/accounts': () =>
      as('GET', '/staff/finance/gl/accounts'),
    'POST /staff/finance/gl/accounts': async () =>
      as('POST', '/staff/finance/gl/accounts', {
        parentId: await suspense(),
        code: `1900.${++code}`,
        nameEn: 'Held for review',
        nameAr: 'محتجز للمراجعة',
      }),
    'GET /staff/finance/gl/accounts/{id}': async () =>
      as('GET', `/staff/finance/gl/accounts/${await suspense()}`),
    'PATCH /staff/finance/gl/accounts/{id}': async () =>
      as('PATCH', `/staff/finance/gl/accounts/${await suspense()}`, {
        nameEn: 'Suspense',
      }),
    'DELETE /staff/finance/gl/accounts/{id}': async () =>
      as('DELETE', `/staff/finance/gl/accounts/${await subAccount()}`),
    'GET /staff/finance/gl/accounts/{id}/ledger': async () =>
      as(
        'GET',
        `/staff/finance/gl/accounts/${await suspense()}/ledger?${period}`,
      ),
    'GET /staff/finance/gl/accounts/{id}/ledger/export': async () =>
      as(
        'GET',
        `/staff/finance/gl/accounts/${await suspense()}/ledger/export?${period}`,
      ),
    'GET /staff/finance/gl/trial-balance': () =>
      as('GET', '/staff/finance/gl/trial-balance'),
    'GET /staff/finance/gl/income-statement': () =>
      as('GET', `/staff/finance/gl/income-statement?${period}`),
    'GET /staff/finance/gl/balance-sheet': () =>
      as('GET', '/staff/finance/gl/balance-sheet'),
    'GET /staff/finance/gl/reconciliation': () =>
      as('GET', '/staff/finance/gl/reconciliation'),
    'GET /staff/finance/gl/entries': () =>
      as('GET', `/staff/finance/gl/entries?${period}`),
    'GET /staff/finance/gl/entries/{id}': async () => {
      const id = await pending();
      await as('POST', `/staff/finance/gl/manual-entries/${id}/approve`);
      const m = (await as('GET', `/staff/finance/gl/manual-entries/${id}`))
        .body as { entryId: string };
      return as('GET', `/staff/finance/gl/entries/${m.entryId}`);
    },
    'POST /staff/finance/gl/entries/{id}/reverse': async () => {
      const id = await pending();
      await as('POST', `/staff/finance/gl/manual-entries/${id}/approve`);
      const m = (await as('GET', `/staff/finance/gl/manual-entries/${id}`))
        .body as { entryId: string };
      return as('POST', `/staff/finance/gl/entries/${m.entryId}/reverse`, {
        postedOn: day(0),
        memo: 'Reversed',
      });
    },
    'GET /staff/finance/gl/journal/export': () =>
      as('GET', `/staff/finance/gl/journal/export?${period}`),
    'GET /staff/finance/gl/manual-entries': () =>
      as('GET', '/staff/finance/gl/manual-entries'),
    'POST /staff/finance/gl/manual-entries': async () =>
      as('POST', '/staff/finance/gl/manual-entries', {
        postedOn: day(0),
        memo: 'Reclassify',
        lines: [
          { accountId: await suspense(), debit: '10' },
          {
            accountId: await inA<string>((tx) =>
              glAccountId(tx, world().a.tenantId, 'opening_balances'),
            ),
            credit: '10',
          },
        ],
      }),
    'GET /staff/finance/gl/manual-entries/{id}': async () =>
      as('GET', `/staff/finance/gl/manual-entries/${await pending()}`),
    'POST /staff/finance/gl/manual-entries/{id}/approve': async () =>
      as('POST', `/staff/finance/gl/manual-entries/${await pending()}/approve`),
    'POST /staff/finance/gl/manual-entries/{id}/reject': async () =>
      as('POST', `/staff/finance/gl/manual-entries/${await pending()}/reject`, {
        reasonCode: 'not_needed',
      }),
    'POST /staff/finance/gl/manual-entries/{id}/withdraw': async () => {
      const made = (
        await as('POST', '/staff/finance/gl/manual-entries', {
          postedOn: day(0),
          memo: 'Mine to withdraw',
          lines: [
            { accountId: await suspense(), debit: '5' },
            {
              accountId: await inA<string>((tx) =>
                glAccountId(tx, world().a.tenantId, 'opening_balances'),
              ),
              credit: '5',
            },
          ],
        })
      ).body as { id: string };
      return as('POST', `/staff/finance/gl/manual-entries/${made.id}/withdraw`);
    },
    'GET /staff/finance/gl/periods': () =>
      as('GET', '/staff/finance/gl/periods'),
    // A's months: closed through two months ago, then the last one reopened.
    'POST /staff/finance/gl/periods/close': () =>
      as('POST', '/staff/finance/gl/periods/close', {
        month: monthBack(day(0), 2),
      }),
    'POST /staff/finance/gl/periods/reopen': async () => {
      const month = monthBack(day(0), 3);
      await as('POST', '/staff/finance/gl/periods/close', { month });
      return as('POST', '/staff/finance/gl/periods/reopen', {
        month,
        reasonCode: 'correction',
      });
    },
  };
}

/** `YYYY-MM`, `n` months before the day's. */
function monthBack(d: string, n: number): string {
  const [y, m] = d.split('-').map(Number);
  const k = y * 12 + (m - 1) - n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
}
