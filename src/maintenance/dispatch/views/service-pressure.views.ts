import { ApiProperty } from '@nestjs/swagger';
import type { PressureState } from '../service-pressure';

/** The open tickets against the technicians available (ADR 0079). */
export class ServicePressureView {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Open tickets one available technician may carry; null: no alert.',
  })
  threshold: number | null;
  @ApiProperty({
    type: Number,
    description: 'New, or in a technician’s hands.',
  })
  open: number;
  @ApiProperty({
    type: Number,
    description: 'Active technicians holding tickets.work who are available.',
  })
  available: number;
  @ApiProperty({
    type: Boolean,
    description: 'open ≥ threshold × available (one at least).',
  })
  underPressure: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the current rise began, as the sweep saw it.',
  })
  since: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  toldAt: Date | null;

  static from(s: PressureState): ServicePressureView {
    return Object.assign(new ServicePressureView(), { ...s });
  }
}
