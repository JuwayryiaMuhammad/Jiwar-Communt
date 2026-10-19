import { ApiProperty } from '@nestjs/swagger';
import { GateKind } from '@prisma/client';
import { FirstNameRefView } from '../../../core/common/http/personal';
import { PlaceView } from '../../places/views/place.views';
import type { GateDirectory } from '../gate-directory.service';

export class DirectoryGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ enum: GateKind, enumName: 'GateKind' })
  kind: GateKind;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '+201000000777',
    description: 'The gate’s own phone (E.164): the post’s, never a person’s.',
  })
  phone: string | null;
  @ApiProperty({
    type: [FirstNameRefView],
    description: 'The guards on shift here now, by first name.',
  })
  guards: FirstNameRefView[];
}

export class DirectoryZoneView {
  @ApiProperty({ type: PlaceView })
  zone: PlaceView;
  @ApiProperty({ type: [FirstNameRefView] })
  guards: FirstNameRefView[];
}

/** The gate directory (ADR 0056): the posts, their phones and who is on shift. */
export class GateDirectoryView {
  @ApiProperty({
    type: [DirectoryGateView],
    description:
      'Every active gate, by name, with its guards on shift (perhaps none).',
  })
  gates: DirectoryGateView[];
  @ApiProperty({
    type: [DirectoryZoneView],
    description: 'The zones with a guard on shift now.',
  })
  zones: DirectoryZoneView[];

  static from(d: GateDirectory): GateDirectoryView {
    return {
      gates: d.gates.map((g) => ({
        id: g.id,
        name: g.name,
        kind: g.kind,
        phone: g.phone,
        guards: g.guards.map((x) => ({ ...x })),
      })),
      zones: d.zones.map((z) => ({
        zone: PlaceView.from(z.zone),
        guards: z.guards.map((x) => ({ ...x })),
      })),
    };
  }
}
