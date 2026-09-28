import {
  catalogProblems,
  CODE_ACCESS_CATALOG,
  type AccessCatalog,
} from './access-catalog';

describe('access catalog', () => {
  it('the code catalog is consistent', () => {
    expect(catalogProblems(CODE_ACCESS_CATALOG)).toEqual([]);
  });

  it('permission keys follow <area>.<action>', () => {
    for (const key of Object.keys(CODE_ACCESS_CATALOG.permissions)) {
      expect(key).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
    }
  });

  it('detects inconsistent catalogs', () => {
    const broken: AccessCatalog = {
      permissions: { 'a.read': { kinds: ['manager'] } },
      defaultRoles: [
        { key: 'manager', kind: 'manager', permissions: ['a.read', 'b.read'] },
        { key: 'resident', kind: 'resident', permissions: ['a.read'] },
      ],
      retired: ['a.read'],
      renamed: { 'a.read': 'c.read' },
      lockout: { roleKey: 'manager', permissions: ['z.manage'] },
    };
    expect(catalogProblems(broken)).toEqual([
      'a.read is both active and retired',
      'rename source a.read is still active',
      'rename target c.read is not an active permission',
      'manager: unknown permission b.read',
      'resident: a.read is not assignable to resident',
      'lockout permission z.manage is not in manager defaults',
    ]);
  });
});
