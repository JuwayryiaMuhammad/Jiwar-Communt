import {
  ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
  RequireAnyPermission,
  RequirePermissions,
} from './require-permissions.decorator';

describe('permission decorators', () => {
  it('store their lists under their own keys', () => {
    class Probe {
      @RequirePermissions('units.read', 'units.create')
      all() {}

      @RequireAnyPermission('workers.manage', 'workers.review')
      any() {}
    }
    const handler = (name: 'all' | 'any') =>
      Object.getOwnPropertyDescriptor(Probe.prototype, name)!.value as object;
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler('all')),
    ).toEqual(['units.read', 'units.create']);
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, handler('any'))).toEqual([
      'workers.manage',
      'workers.review',
    ]);
    expect(
      Reflect.getMetadata(ANY_PERMISSIONS_KEY, handler('all')),
    ).toBeUndefined();
  });

  it('refuses both on one route, in either order, when the class loads', () => {
    expect(() => {
      class A {
        @RequirePermissions('units.read')
        @RequireAnyPermission('workers.manage')
        route() {}
      }
      return A;
    }).toThrow(/not both/);
    expect(() => {
      class B {
        @RequireAnyPermission('workers.manage')
        @RequirePermissions('units.read')
        route() {}
      }
      return B;
    }).toThrow(/not both/);
  });
});
