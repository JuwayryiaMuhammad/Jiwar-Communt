import type { Response } from 'supertest';
import { SAMPLE } from '../setup/files';
import { fileHelpers } from '../setup/files';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0068, as A's guard (on shift
 * at A's gate) or A's manager.
 */
export function guardVendorCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as =
    (who: 'manager' | 'guard') =>
    (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[who],
        body: payload,
      });
  const manager = as('manager');
  const guard = as('guard');
  let n = 0;
  /** A face check A's guard made, with face checks turned on in A. */
  const aFaceCheck = async (): Promise<Response> => {
    await manager('PATCH', '/staff/gate/settings', {
      faceChecks: true,
      faceChecksNoticePosted: true,
    });
    const files = fileHelpers(world().h);
    const token = world().a.tokens.guard;
    const id = await files.uploaded(
      token,
      'gate_face_probe',
      'image/png',
      Buffer.concat([
        SAMPLE['image/png'].subarray(0, 8),
        Buffer.alloc(40, ++n),
      ]),
    );
    await files.finalize(token, id);
    return guard('POST', '/gate/face-checks', { photoFileId: id });
  };
  return {
    'POST /gate/face-checks': aFaceCheck,
    'GET /gate/face-checks/{id}': async () =>
      guard(
        'GET',
        `/gate/face-checks/${((await aFaceCheck()).body as { id: string }).id}`,
      ),
  };
}
