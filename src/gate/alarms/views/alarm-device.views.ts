import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import type { AlarmDeviceRead } from '../alarm-devices.service';

class AlarmPairingView {
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({ type: String, format: 'uuid' })
  shiftId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  pairedAt: Date;
}

/** A guard-down wearable (ADR 0068), and who wears it on shift now. */
export class AlarmDeviceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  deviceRef: string;
  @ApiProperty({ type: String })
  label: string;
  @ApiProperty({ enum: ['active', 'retired'], enumName: 'AlarmDeviceStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  retireReason: string | null;
  @ApiProperty({
    type: AlarmPairingView,
    nullable: true,
    description: 'The guard on shift wearing it; null when nobody is.',
  })
  pairing: AlarmPairingView | null;

  static from(r: AlarmDeviceRead): AlarmDeviceView {
    const d = r.device;
    return {
      id: d.id,
      deviceRef: d.deviceRef,
      label: d.label,
      status: d.retiredAt ? 'retired' : 'active',
      retiredAt: d.retiredAt,
      retireReason: d.retireReason,
      pairing: r.pairing
        ? {
            guard: accountRef(r.pairing.guard),
            shiftId: r.pairing.shiftId,
            pairedAt: r.pairing.pairedAt,
          }
        : null,
    };
  }
}

/** What a guard sees of the device they paired. */
export class PairedAlarmDeviceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  label: string;
  @ApiProperty({ type: String, format: 'uuid' })
  shiftId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  pairedAt: Date;

  static from(r: AlarmDeviceRead): PairedAlarmDeviceView {
    return {
      id: r.device.id,
      label: r.device.label,
      shiftId: r.pairing!.shiftId,
      pairedAt: r.pairing!.pairedAt,
    };
  }
}
