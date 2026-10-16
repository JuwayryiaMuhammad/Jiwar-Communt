import { ApiProperty } from '@nestjs/swagger';
import {
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import type { MaterialEntryRecord } from '../material-entries.service';

/** Materials brought in, as the guard logged them (ADR 0049). */
export class MaterialEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  permitId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'W-0042' })
  permitReference: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  gateId: string;
  @ApiProperty({
    type: String,
    description: 'What came in, in the guard’s words.',
  })
  description: string;
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  guard: FirstNameRefView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  static from(r: MaterialEntryRecord): MaterialEntryView {
    return {
      id: r.entry.id,
      unitId: r.entry.unitId,
      unitCode: r.unitCode,
      permitId: r.entry.permitId,
      permitReference: r.permitReference,
      gateId: r.entry.gateId,
      description: r.entry.description,
      guard: r.guard ? firstNameRef(r.guard) : null,
      occurredAt: r.entry.occurredAt,
    };
  }
}
