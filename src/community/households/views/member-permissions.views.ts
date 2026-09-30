import { ApiProperty } from '@nestjs/swagger';
import { MemberPermission } from '@prisma/client';
import { MemberGrantResponse } from '../../residents/views/me-units.views';
import type {
  DeferredActionView,
  MemberPermissionsView,
} from '../member-permissions.service';

export class MemberPermissionsResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: [MemberGrantResponse] })
  grants: MemberGrantResponse[];

  static from(p: MemberPermissionsView): MemberPermissionsResponse {
    return {
      memberId: p.memberId,
      grants: p.grants.map((g) => MemberGrantResponse.from(g)),
    };
  }
}

/** A request waiting for the primary; the payload stays out of v0 (v0-notes). */
export class DeferredActionResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ enum: MemberPermission, enumName: 'MemberPermission' })
  permission: MemberPermission;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(d: DeferredActionView): DeferredActionResponse {
    return {
      id: d.id,
      memberId: d.memberId,
      permission: d.permission,
      createdAt: d.createdAt,
    };
  }
}
