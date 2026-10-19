import { enrolMessage } from '../../src/gate/offline/device-envelope';
import { GateDevicesService } from '../../src/gate/offline/gate-devices.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { batchRow, bundleRow, flagRow } from '../setup/offline-rows';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import { newDevice, signAs } from '../setup/offline';
import type { Side } from './world';

/** B's records of the gate offline (ADR 0057): foreign ids for the matrix. */
export interface OfflineWorld {
  /** A device B's guard enrolled. */
  bGateDeviceId: string;
  /** A flag on a batch of B's device (rows written directly). */
  bOfflineFlagId: string;
  /** That batch. */
  bOfflineBatchId: string;
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
  const rows = await helpers.asManager(b, () =>
    h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
      const at = { tenantId: b.tenantId, deviceId: d.id };
      await bundleRow(tx, {
        ...at,
        shiftId: b.shiftId,
        gateId: b.gateId,
        guardId: b.ids.guard,
      });
      const batchId = await batchRow(tx, { ...at, uploadedById: b.ids.guard });
      return { batchId, flagId: await flagRow(tx, { ...at, batchId }) };
    }),
  );
  return {
    bGateDeviceId: d.id,
    bOfflineFlagId: rows.flagId,
    bOfflineBatchId: rows.batchId,
  };
}
