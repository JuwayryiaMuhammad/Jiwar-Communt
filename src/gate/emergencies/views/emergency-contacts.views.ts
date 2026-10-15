import { ApiProperty } from '@nestjs/swagger';
import type { EmergencyContacts } from '../emergency-contacts.service';

/** Someone who lives in the unit. */
export class FamilyContactView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  name: string | null;
  @ApiProperty({
    enum: ['owner', 'tenant', 'member'],
    enumName: 'EmergencyFamilyRole',
    description: 'An occupant (owner or tenant) or a household member.',
  })
  role: 'owner' | 'tenant' | 'member';
  @ApiProperty({ type: Boolean, description: 'The unit’s primary resident.' })
  isPrimary: boolean;
  @ApiProperty({ type: String, nullable: true, example: '+201000000123' })
  phone: string | null;
}

/** A gate in service and its phone. */
export class GateContactView {
  @ApiProperty({ type: String, format: 'uuid' })
  gateId: string;
  @ApiProperty({ type: String, example: 'North gate' })
  name: string;
  @ApiProperty({ enum: ['gate'], description: 'Always `gate`.' })
  role: 'gate';
  @ApiProperty({ type: String, example: '+20225550100' })
  phone: string;
}

/** The compound's own numbers, named by role in the app's words. */
export class ManagementContactView {
  @ApiProperty({
    enum: ['office', 'duty', 'emergency'],
    enumName: 'EmergencyManagementRole',
    description:
      '`office`: the community office; `duty`: the duty manager; `emergency`: the compound’s emergency number.',
  })
  role: 'office' | 'duty' | 'emergency';
  @ApiProperty({ type: String, example: '+20225550101' })
  phone: string;
}

/** A unit's emergency contacts (ADR 0047). */
export class EmergencyContactsView {
  @ApiProperty({
    type: [FamilyContactView],
    description:
      'The other people who live in the unit, the primary first. Empty for a caller who does not live there (a landlord).',
  })
  family: FamilyContactView[];
  @ApiProperty({
    type: [GateContactView],
    description: 'The gates in service that have a phone, by name.',
  })
  gates: GateContactView[];
  @ApiProperty({
    type: [ManagementContactView],
    description: 'Each of the three when the management has set it.',
  })
  management: ManagementContactView[];

  static from(c: EmergencyContacts): EmergencyContactsView {
    return {
      family: c.family.map((f) => ({ ...f })),
      gates: c.gates.map((g) => ({ ...g, role: 'gate' as const })),
      management: c.management.map((m) => ({ ...m })),
    };
  }
}
