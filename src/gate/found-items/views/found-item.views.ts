import { ApiProperty } from '@nestjs/swagger';
import type { FoundItem, Place } from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { PresignedReadView } from '../../../core/files/views/file.views';
import { PlaceView } from '../../places/views/place.views';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';

export interface FoundItemContext {
  names: DutyNames;
  places: Map<string, Place>;
  units: Map<
    string,
    { unitId: string; unitCode: string; building: string | null }
  >;
  photos: Map<string, { url: string; expiresAt: Date }[]>;
}

export class FoundItemClaimView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The owner’s unit.',
  })
  unitCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'As told; null after 30 days.',
  })
  name: string | null;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
}

const STATUS = {
  enum: ['at_gate', 'with_management', 'claimed'],
  enumName: 'FoundItemStatus',
};

class FoundItemBodyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  description: string;
  @ApiProperty({
    type: PlaceView,
    nullable: true,
    description: 'Where it was found.',
  })
  place: PlaceView | null;
  @ApiProperty({ type: String, nullable: true })
  location: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  foundAt: Date;
  @ApiProperty({
    type: PostView,
    nullable: true,
    description:
      'Where it was registered: the post of the guard’s shift; null at the office.',
  })
  registeredAt: PostView | null;
  @ApiProperty(STATUS)
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  receivedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  claimedAt: Date | null;
  @ApiProperty({ type: FoundItemClaimView, nullable: true })
  claim: FoundItemClaimView | null;
  @ApiProperty({ type: [PresignedReadView] })
  photos: PresignedReadView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

function body(i: FoundItem, c: FoundItemContext): FoundItemBodyView {
  const place = i.placeId ? c.places.get(i.placeId) : undefined;
  return {
    id: i.id,
    description: i.description,
    place: place ? PlaceView.from(place) : null,
    location: i.location,
    foundAt: i.foundAt,
    registeredAt:
      i.gateId || i.zoneId
        ? PostView.of({ gateId: i.gateId, placeId: i.zoneId }, c.names)
        : null,
    status: i.status,
    receivedAt: i.receivedAt,
    claimedAt: i.claimedAt,
    claim: i.claimedAt
      ? {
          unitCode: i.claimantUnitId
            ? (c.units.get(i.claimantUnitId)?.unitCode ?? null)
            : null,
          name: i.claimantName,
          note: i.claimNote,
        }
      : null,
    photos: c.photos.get(i.id) ?? [],
    createdAt: i.createdAt,
  };
}

const person = <V>(
  id: string | null,
  c: FoundItemContext,
  as: (a: { id: string; fullName: string | null; status: string }) => V,
): V | null => {
  const a = id ? c.names.people.get(id) : undefined;
  return a ? as(a) : null;
};

/** A found item as the guards read the register: colleagues by first name. */
export class FoundItemView extends FoundItemBodyView {
  @ApiProperty({ type: FirstNameRefView })
  registeredBy: FirstNameRefView;

  static from(i: FoundItem, c: FoundItemContext): FoundItemView {
    return {
      ...body(i, c),
      registeredBy: person(i.registeredById, c, firstNameRef)!,
    };
  }
}

/** A found item as the management reads it: full names. */
export class StaffFoundItemView extends FoundItemBodyView {
  @ApiProperty({ type: AccountRefView })
  registeredBy: AccountRefView;
  @ApiProperty({ type: AccountRefView, nullable: true })
  receivedBy: AccountRefView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  claimRecordedBy: AccountRefView | null;

  static of(i: FoundItem, c: FoundItemContext): StaffFoundItemView {
    return {
      ...body(i, c),
      registeredBy: person(i.registeredById, c, accountRef)!,
      receivedBy: person(i.receivedById, c, accountRef),
      claimRecordedBy: person(i.claimRecordedById, c, accountRef),
    };
  }
}
