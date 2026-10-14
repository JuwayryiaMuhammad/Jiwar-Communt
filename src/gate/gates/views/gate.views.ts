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

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'E.164, or null (ADR 0043).',
  })
  phone: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(g: Gate): GateView {
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      status: g.status,
      phone: g.phone,
      createdAt: g.createdAt,
    };
  }
}

/** What a resident sees of a gate: that it exists and whether it is open. */
export class GateStatusView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({
    type: Boolean,
    description: 'The gate is in service (its status is `active`).',
  })
  open: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The gate’s phone, E.164, or null (ADR 0043).',
  })
  phone: string | null;

  static from(
    g: Pick<Gate, 'id' | 'name' | 'status' | 'phone'>,
  ): GateStatusView {
    return {
      id: g.id,
      name: g.name,
      open: g.status === 'active',
      phone: g.phone,
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
