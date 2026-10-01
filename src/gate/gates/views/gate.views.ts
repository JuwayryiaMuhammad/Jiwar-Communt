import { ApiProperty } from '@nestjs/swagger';
import { GateKind, GateStatus, type Gate } from '@prisma/client';

export class GateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ enum: GateKind, enumName: 'GateKind' })
  kind: GateKind;

  @ApiProperty({ enum: GateStatus, enumName: 'GateStatus' })
  status: GateStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(g: Gate): GateView {
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      status: g.status,
      createdAt: g.createdAt,
    };
  }
}

/** What a guard picks a gate from. */
export class GuardGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ enum: GateKind, enumName: 'GateKind' })
  kind: GateKind;

  static from(g: Gate): GuardGateView {
    return { id: g.id, name: g.name, kind: g.kind };
  }
}
