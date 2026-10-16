import { CODE_ACCESS_CATALOG } from './access-catalog';
import { DerivedGrants, isDerived } from './derived-grants';
import { PERMISSIONS } from './permissions';

describe('derived grants (ADR 0051)', () => {
  it('a derived permission may be held by no role kind, and no default role lists it', () => {
    const derived = Object.entries(PERMISSIONS).filter(([p]) => isDerived(p));
    expect(derived.map(([p]) => p)).toEqual(['governance.board']);
    for (const [, def] of derived) expect(def.kinds).toEqual([]);
    for (const role of CODE_ACCESS_CATALOG.defaultRoles)
      for (const [p] of derived) expect(role.permissions).not.toContain(p);
  });

  it('asks the registered check, every time, and nothing else', async () => {
    const grants = new DerivedGrants();
    let seated = true;
    const asked: string[] = [];
    grants.register('governance.board', (accountId) => {
      asked.push(accountId);
      return Promise.resolve(seated);
    });
    expect(await grants.holds('governance.board', 'a')).toBe(true);
    seated = false;
    expect(await grants.holds('governance.board', 'a')).toBe(false);
    expect(await grants.heldBy('a')).toEqual([]);
    seated = true;
    expect(await grants.heldBy('a')).toEqual(['governance.board']);
    expect(asked).toEqual(['a', 'a', 'a', 'a']);
  });

  it('refuses a role permission and a second check', () => {
    const grants = new DerivedGrants();
    expect(() =>
      grants.register('governance.read', () => Promise.resolve(true)),
    ).toThrow('not a derived permission');
    grants.register('governance.board', () => Promise.resolve(true));
    expect(() =>
      grants.register('governance.board', () => Promise.resolve(true)),
    ).toThrow('already has a check');
  });

  it('a permission nothing checks is not held', async () => {
    expect(await new DerivedGrants().holds('governance.board', 'a')).toBe(
      false,
    );
  });
});
