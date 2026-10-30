import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type GuardAlarmDevice,
  type GuardAlarmPairing,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';

type Person = { id: string; fullName: string | null; status: string };

export interface AlarmDeviceRead {
  device: GuardAlarmDevice;
  pairing: (GuardAlarmPairing & { guard: Person }) | null;
}

export const alarmDeviceNotFound = () =>
  appError.notFound(ErrorCode.ALARM_DEVICE_NOT_FOUND, 'Alarm device not found');
const retired = () =>
  appError.conflict(ErrorCode.ALARM_DEVICE_RETIRED, 'Retired already');

/**
 * Guard-down wearables (ADR 0068). The management (`gate_devices.manage`)
 * registers a vendor's device by its reference — one live device per
 * reference — names it, and retires it once with a reason, which ends its
 * pairing. A guard on shift (`gate.operate`) pairs one for the shift: one
 * open pairing a device and one a guard, a re-pair ending the old ones; the
 * pairing ends with the shift. Locks: the account, then the shift, FOR
 * SHARE (ADR 0056), then the device FOR UPDATE.
 */
@Injectable()
export class AlarmDevicesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly safety: SafetyCore,
    private readonly shifts: ShiftsService,
  ) {}

  onModuleInit(): void {
    this.shifts.onEnded(async (tx, shift) => {
      const open = await tx.guardAlarmPairing.findMany({
        where: { shiftId: shift.id, endedAt: null },
      });
      for (const p of open) await this.end(tx, p, 'shift_ended');
    });
  }

  // --------------------------------------------------------------------------
  // The management
  // --------------------------------------------------------------------------

  register(input: {
    deviceRef: string;
    label: string;
  }): Promise<AlarmDeviceRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const deviceRef = input.deviceRef.trim();
      if (
        await tx.guardAlarmDevice.count({
          where: { deviceRef, retiredAt: null },
        })
      )
        throw duplicate();
      const id = newId();
      try {
        await tx.guardAlarmDevice.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            deviceRef,
            label: input.label.trim(),
            registeredByAccountId: this.ctx.accountId,
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
          throw duplicate();
        throw e;
      }
      await this.audit.record(tx, {
        action: 'guard_alarm_device.registered',
        targetId: id,
      });
      return this.read(tx, id);
    });
  }

  list(
    status: 'active' | 'retired' | 'all' = 'active',
  ): Promise<AlarmDeviceRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.guardAlarmDevice.findMany({
        where:
          status === 'active'
            ? { retiredAt: null }
            : status === 'retired'
              ? { retiredAt: { not: null } }
              : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
        select: { id: true },
      });
      const out: AlarmDeviceRead[] = [];
      for (const r of rows) out.push(await this.read(tx, r.id));
      return out;
    });
  }

  rename(id: string, label: string): Promise<AlarmDeviceRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const device = await this.lockDevice(tx, id);
      if (device.retiredAt) throw retired();
      if (device.label !== label.trim()) {
        await tx.guardAlarmDevice.update({
          where: { id },
          data: { label: label.trim() },
        });
        await this.audit.record(tx, {
          action: 'guard_alarm_device.renamed',
          targetId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  retire(id: string, code: string | undefined): Promise<AlarmDeviceRead> {
    const reasonCode = requireReasonCodeOnly(
      code,
      REASON_CODES.alarmDeviceRetire,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const device = await this.lockDevice(tx, id);
      if (device.retiredAt) throw retired();
      const open = await tx.guardAlarmPairing.findFirst({
        where: { deviceId: id, endedAt: null },
      });
      if (open) await this.end(tx, open, 'device_retired');
      await tx.guardAlarmDevice.update({
        where: { id },
        data: {
          retiredAt: await dbNow(tx),
          retiredByAccountId: this.ctx.accountId,
          retireReason: reasonCode,
        },
      });
      await this.audit.record(tx, {
        action: 'guard_alarm_device.retired',
        targetId: id,
        metadata: { reasonCode, wasPaired: open !== null },
      });
      return this.read(tx, id);
    });
  }

  // --------------------------------------------------------------------------
  // The guard on shift
  // --------------------------------------------------------------------------

  /** Pairs a device for the guard's shift, ending what either had. */
  pair(deviceId: string): Promise<AlarmDeviceRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOnDutyLocked(tx);
      const device = await this.lockDevice(tx, deviceId);
      if (device.retiredAt) throw retired();
      const me = this.ctx.accountId;
      const mine = await tx.guardAlarmPairing.findFirst({
        where: { guardAccountId: me, endedAt: null },
      });
      const its = await tx.guardAlarmPairing.findFirst({
        where: { deviceId, endedAt: null },
      });
      if (mine && its && mine.id === its.id && mine.shiftId === shift.id)
        return this.read(tx, deviceId);
      if (mine) await this.end(tx, mine, 'repaired');
      if (its && its.id !== mine?.id) await this.end(tx, its, 'repaired');
      const id = newId();
      await tx.guardAlarmPairing.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          deviceId,
          guardAccountId: me,
          shiftId: shift.id,
          pairedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'guard_alarm.paired',
        targetId: id,
        metadata: { deviceId, shiftId: shift.id },
      });
      return this.read(tx, deviceId);
    });
  }

  /** The guard ends their own pairing; with none, nothing to do. */
  unpair(): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const mine = await tx.guardAlarmPairing.findFirst({
        where: { guardAccountId: this.ctx.accountId, endedAt: null },
      });
      if (!mine) return;
      await tx.$queryRaw`
        SELECT id FROM guard_alarm_devices WHERE id = ${mine.deviceId}::uuid FOR UPDATE`;
      const still = await tx.guardAlarmPairing.findUniqueOrThrow({
        where: { id: mine.id },
      });
      if (!still.endedAt) await this.end(tx, still, 'unpaired');
    });
  }

  private async end(
    tx: TenantTxClient,
    pairing: GuardAlarmPairing,
    reason: 'unpaired' | 'shift_ended' | 'repaired' | 'device_retired',
  ): Promise<void> {
    await tx.guardAlarmPairing.update({
      where: { id: pairing.id },
      data: { endedAt: await dbNow(tx), endReason: reason },
    });
    await this.audit.record(tx, {
      action: 'guard_alarm.unpaired',
      targetId: pairing.id,
      metadata: { deviceId: pairing.deviceId, reason },
    });
  }

  private async lockDevice(
    tx: TenantTxClient,
    id: string,
  ): Promise<GuardAlarmDevice> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_alarm_devices WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw alarmDeviceNotFound();
    return tx.guardAlarmDevice.findUniqueOrThrow({ where: { id } });
  }

  async read(tx: TenantTxClient, id: string): Promise<AlarmDeviceRead> {
    const device = await tx.guardAlarmDevice.findUnique({ where: { id } });
    if (!device) throw alarmDeviceNotFound();
    const pairing = await tx.guardAlarmPairing.findFirst({
      where: { deviceId: id, endedAt: null },
    });
    const guard = pairing
      ? await tx.account.findUniqueOrThrow({
          where: { id: pairing.guardAccountId },
          select: { id: true, fullName: true, status: true },
        })
      : null;
    return {
      device,
      pairing: pairing && guard ? { ...pairing, guard } : null,
    };
  }
}

const duplicate = () =>
  appError.conflict(
    ErrorCode.DUPLICATE_RESOURCE,
    'This device is registered already',
    { fields: [{ field: 'deviceRef', code: FieldErrorCode.DUPLICATE_VALUE }] },
  );
