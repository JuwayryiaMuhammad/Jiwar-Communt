import { ApiProperty } from '@nestjs/swagger';
import {
  GateDirection,
  GateEntryMethod,
  GateSubjectType,
} from '@prisma/client';
import type { LogSearchResult } from '../log-search.service';

export class LogSearchGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
}

/** An entry the search found: never a name. */
export class LogSearchEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: LogSearchGateView })
  gate: LogSearchGateView;
  @ApiProperty({ enum: GateSubjectType, enumName: 'GateSubjectType' })
  subjectType: GateSubjectType;
  @ApiProperty({ type: String, format: 'uuid' })
  subjectId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: GateDirection, enumName: 'GateDirection' })
  direction: GateDirection;
  @ApiProperty({ enum: GateEntryMethod, enumName: 'GateEntryMethod' })
  method: GateEntryMethod;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ type: Boolean })
  unconfirmed: boolean;
}

export class LogSearchView {
  @ApiProperty({ type: String })
  from: string;
  @ApiProperty({ type: String })
  to: string;
  @ApiProperty({ type: [LogSearchEntryView], description: 'Newest first.' })
  entries: LogSearchEntryView[];
  @ApiProperty({
    type: Boolean,
    description: 'More matched than the 200 shown: narrow the search.',
  })
  truncated: boolean;

  static from(r: LogSearchResult): LogSearchView {
    return r;
  }
}
