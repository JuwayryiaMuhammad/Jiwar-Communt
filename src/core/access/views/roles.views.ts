import { ApiProperty } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import type { PermissionDefinition } from '../permissions';
import type { RoleWithPermissions } from '../roles.service';

export class RoleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'System roles are translated by key.',
  })
  key: string;
  @ApiProperty({ type: String, nullable: true })
  name: string | null;
  @ApiProperty({ enum: AccountType, enumName: 'AccountType' })
  kind: AccountType;
  @ApiProperty({ type: Boolean })
  isSystem: boolean;
  @ApiProperty({ type: [String] })
  permissions: string[];

  static from(r: RoleWithPermissions): RoleView {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      kind: r.kind,
      isSystem: r.isSystem,
      permissions: [...r.permissions],
    };
  }
}

/** A permission of the code catalog, and the role kinds it may ever reach. */
export class PermissionView {
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ enum: AccountType, enumName: 'AccountType', isArray: true })
  kinds: AccountType[];

  static from([key, def]: [string, PermissionDefinition]): PermissionView {
    return { key, kinds: [...def.kinds] };
  }
}
