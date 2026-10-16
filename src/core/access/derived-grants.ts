import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type Permission } from './permissions';

/**
 * Whether the account holds the permission now. Runs in the request's
 * tenant context (RLS), outside any transaction of the action.
 */
export type DerivedCheck = (accountId: string) => Promise<boolean>;

/**
 * Permissions held by what an account is rather than by its role (ADR
 * 0051): a sitting board member's `governance.board`. An account has one
 * role for life, and a seat comes and goes with a term.
 *
 * The domain that owns the fact registers one check per permission. It is
 * asked on every request that needs the permission and never cached, so a
 * term that ends or a seat that is taken away stops working on the very
 * next request: there is nothing to invalidate. A route that acts on the
 * grant checks the seat again inside its transaction, under its lock.
 */
@Injectable()
export class DerivedGrants {
  private readonly checks = new Map<Permission, DerivedCheck>();

  register(permission: Permission, check: DerivedCheck): void {
    if (!isDerived(permission))
      throw new Error(`${permission} is not a derived permission`);
    if (this.checks.has(permission))
      throw new Error(`${permission} already has a check`);
    this.checks.set(permission, check);
  }

  /** False for a permission nothing registered a check for. */
  async holds(permission: Permission, accountId: string): Promise<boolean> {
    const check = this.checks.get(permission);
    return check ? check(accountId) : false;
  }

  /** Every derived permission the account holds now, sorted. */
  async heldBy(accountId: string): Promise<Permission[]> {
    const held: Permission[] = [];
    for (const [permission, check] of this.checks)
      if (await check(accountId)) held.push(permission);
    return held.sort();
  }
}

export function isDerived(permission: string): boolean {
  const def = (PERMISSIONS as Record<string, { derived?: true }>)[permission];
  return def?.derived === true;
}
