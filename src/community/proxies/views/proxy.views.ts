import { ApiProperty } from '@nestjs/swagger';
import { PROXY_SCOPES } from '../../capabilities/capabilities';
import type { ProxyPlace, ProxyRead } from '../proxies.service';

/** A unit proxy, as the unit's owners and the management see it (ADR 0063). */
export class ProxyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ enum: ['invited', 'active', 'ended'] })
  status: string;
  @ApiProperty({ enum: PROXY_SCOPES, isArray: true })
  scopes: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The invite’s name, then the account’s; null once ended.',
  })
  name: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  inviteExpiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'revoked | expired | invite_expired | ownership_transferred | household_ended | appointer_left | erased',
  })
  endReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(p: ProxyRead): ProxyView {
    return { ...p };
  }
}

/** A proxy just appointed: the link's token, shown once. */
export class CreatedProxyView {
  @ApiProperty({ type: ProxyView })
  proxy: ProxyView;
  @ApiProperty({
    type: String,
    description:
      'Shown once. The link is `<PUBLIC_APP_URL>/x#<token>`; share it with the person.',
  })
  token: string;
}

/** A unit the caller looks after (ADR 0063). */
export class ProxyPlaceView {
  @ApiProperty({ type: String, format: 'uuid' })
  proxyId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: PROXY_SCOPES, isArray: true })
  scopes: string[];
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'The unit is closed or has no primary: you may act.',
  })
  usable: boolean;

  static from(p: ProxyPlace): ProxyPlaceView {
    return { ...p };
  }
}

export class ProxyCodeRequestedView {
  @ApiProperty({ type: String })
  message: string;
}

export const PROXY_CODE_REQUESTED: ProxyCodeRequestedView = {
  message:
    'If this invitation is valid, a code has been sent to the invited email.',
};

export class ProxyAcceptedView {
  @ApiProperty({ type: Boolean, example: true })
  accepted: true;
}
