import { enrolMessage } from '../../src/gate/offline/device-envelope';
import { GateDevicesService } from '../../src/gate/offline/gate-devices.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import { newDevice, signAs } from '../setup/offline';
import type { Side } from './world';

/** B's records of the gate offline (ADR 0057): foreign ids for the matrix. */
export interface OfflineWorld {
  /** A device B's guard enrolled. */
  bGateDeviceId: string;
}

export async function offlineWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<OfflineWorld> {
  const d = newDevice();
  await helpers.as(b, { id: b.ids.guard, type: 'staff' }, () =>
    h.moduleRef.get(GateDevicesService).enrol({
      id: d.id,
      publicKey: d.publicKey,
      proof: signAs(d, enrolMessage(b.tenantId, d.id, d.publicKey)),
    }),
  );
  return { bGateDeviceId: d.id };
}
