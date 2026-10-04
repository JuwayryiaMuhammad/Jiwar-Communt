import type { TenantTxClient } from '../database/tenant-tx.service';
import { RoleLifecycle } from './role-lifecycle';

const tx = {} as TenantTxClient;

describe('RoleLifecycle', () => {
  it('tells every handler, in order, what the role gained and lost', async () => {
    const lifecycle = new RoleLifecycle();
    const seen: string[] = [];
    lifecycle.onPermissionsChanged((t, roleId, added, removed) => {
      seen.push(`a:${roleId}:${added.join()}:${removed.join()}:${t === tx}`);
      return Promise.resolve();
    });
    lifecycle.onPermissionsChanged((_t, roleId) => {
      seen.push(`b:${roleId}`);
      return Promise.resolve();
    });
    await lifecycle.permissionsChanged(tx, 'r1', ['x', 'y'], ['z']);
    expect(seen).toEqual(['a:r1:x,y:z:true', 'b:r1']);
  });

  it('says nothing when nothing changed', async () => {
    const lifecycle = new RoleLifecycle();
    const handler = jest.fn(() => Promise.resolve());
    lifecycle.onPermissionsChanged(handler);
    await lifecycle.permissionsChanged(tx, 'r1', [], []);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a handler’s failure through, so the changing transaction rolls back', async () => {
    const lifecycle = new RoleLifecycle();
    lifecycle.onPermissionsChanged(() => Promise.reject(new Error('boom')));
    const later = jest.fn(() => Promise.resolve());
    lifecycle.onPermissionsChanged(later);
    await expect(
      lifecycle.permissionsChanged(tx, 'r1', [], ['z']),
    ).rejects.toThrow('boom');
    expect(later).not.toHaveBeenCalled();
  });
});
