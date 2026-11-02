import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { safetyReference } from '../../safety/safety-rules';
import type {
  IncidentActionRecord,
  OwnActionRecord,
} from '../incident-actions.service';

const STATES = ['open', 'done', 'cancelled'] as const;

/** A corrective action as the incidents' keepers see it (ADR 0087). */
export class IncidentActionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  incidentId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once an erasure cleared it.',
  })
  description: string | null;
  @ApiProperty({ type: AccountRefView })
  owner: AccountRefView;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ enum: STATES, enumName: 'IncidentActionState' })
  state: string;
  @ApiProperty({
    type: Boolean,
    description: 'Open and past its day on the compound’s today.',
  })
  overdue: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  doneBy: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  doneNote: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.incidentActionCancel,
    enumName: 'IncidentActionCancelReason',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({ type: AccountRefView })
  createdBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: IncidentActionRecord): IncidentActionView {
    const a = r.action;
    return {
      id: a.id,
      incidentId: a.incidentId,
      description: a.description,
      owner: accountRef(r.owner),
      dueOn: a.dueOn.toISOString().slice(0, 10),
      state: a.status,
      overdue: r.overdue,
      doneAt: a.doneAt,
      doneBy: r.doneBy && accountRef(r.doneBy),
      doneNote: a.doneNote,
      cancelledAt: a.cancelledAt,
      cancelReason: a.cancelReason,
      createdBy: accountRef(r.createdBy),
      createdAt: a.createdAt,
    };
  }
}

export class OwnActionIncidentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'I-0001.' })
  reference: string;
  @ApiProperty({
    enum: REASON_CODES.incidentType,
    enumName: 'IncidentType',
  })
  type: string;
  @ApiProperty({
    enum: REASON_CODES.incidentSeverity,
    enumName: 'IncidentSeverity',
  })
  severity: string;
}

/**
 * The owner's own action (ADR 0087): what to do and by when, and the
 * incident by its reference, type and severity — never its investigation.
 */
export class OwnIncidentActionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: OwnActionIncidentView })
  incident: OwnActionIncidentView;
  @ApiProperty({ type: String, nullable: true })
  description: string | null;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({ enum: STATES, enumName: 'IncidentActionState' })
  state: string;
  @ApiProperty({ type: Boolean })
  overdue: boolean;
  @ApiProperty({ type: String, nullable: true })
  doneNote: string | null;

  static from(r: OwnActionRecord): OwnIncidentActionView {
    const a = r.action;
    return {
      id: a.id,
      incident: {
        id: r.incident.id,
        reference: safetyReference('I', r.incident.number),
        type: r.incident.type,
        severity: r.incident.severity,
      },
      description: a.description,
      dueOn: a.dueOn.toISOString().slice(0, 10),
      state: a.status,
      overdue: r.overdue,
      doneNote: a.doneNote,
    };
  }
}
