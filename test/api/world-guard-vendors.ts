import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's records of the guard vendor adapters (ADR 0068): foreign ids for the matrix. */
export interface GuardVendorsWorld {
  /** A face check B's guard made (its probe gone; rows written directly). */
  bFaceCheckId: string;
  /** A control room event of B's (a lockdown's, written directly). */
  bControlRoomEventId: string;
  /** A guard-down wearable B's supervisor registered (written directly). */
  bAlarmDeviceId: string;
  /** A call B's guard made to B's home, missed (written directly). */
  bGateCallId: string;
}

export async function guardVendorsWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<GuardVendorsWorld> {
  const bFaceCheckId = newId();
  const bControlRoomEventId = newId();
  const bAlarmDeviceId = newId();
  const bGateCallId = newId();
  await helpers.asManager(b, () =>
    h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
      await tx.gateFaceCheck.create({
        data: {
          id: bFaceCheckId,
          tenantId: b.tenantId,
          shiftId: b.shiftId,
          gateId: b.gateId,
          guardAccountId: b.ids.guard,
          probeDeletedAt: new Date(),
        },
      });
      await tx.controlRoomEvent.create({
        data: {
          id: bControlRoomEventId,
          tenantId: b.tenantId,
          kind: 'device_sync_overdue',
          severity: 'normal',
          sourceType: 'gate_device',
          sourceId: newId(),
          gateId: b.gateId,
        },
      });
      await tx.guardAlarmDevice.create({
        data: {
          id: bAlarmDeviceId,
          tenantId: b.tenantId,
          deviceRef: `b-${bAlarmDeviceId}`,
          label: 'B vest',
          registeredByAccountId: b.ids.supervisor,
        },
      });
      await tx.gateCall.create({
        data: {
          id: bGateCallId,
          tenantId: b.tenantId,
          unitId: b.homeUnitId,
          guardAccountId: b.ids.guard,
          shiftId: b.shiftId,
          gateId: b.gateId,
          reasonCode: 'other',
          status: 'missed',
          endedAt: new Date(),
          endReason: 'missed',
        },
      });
    }),
  );
  return { bFaceCheckId, bControlRoomEventId, bAlarmDeviceId, bGateCallId };
}
