import { ApiProperty } from '@nestjs/swagger';
import {
  SERVICE_VEHICLE_KINDS,
  type ServiceVehicleKind,
} from '../service-vehicle-rules';
import type { ServiceVehicleRecord } from '../service-vehicles.service';

export class ServiceVehicleGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
}

export class ServiceVehicleFacilityView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

/** A service vehicle's visit (ADR 0056): never who recorded it. */
export class ServiceVehicleResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'As typed, tidied.' })
  plate: string;
  @ApiProperty({ enum: SERVICE_VEHICLE_KINDS, enumName: 'ServiceVehicleKind' })
  kind: ServiceVehicleKind;
  @ApiProperty({ type: String })
  company: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: ServiceVehicleFacilityView, nullable: true })
  facility: ServiceVehicleFacilityView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: Date;
  @ApiProperty({ type: ServiceVehicleGateView })
  enteredGate: ServiceVehicleGateView;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  exitedAt: Date | null;
  @ApiProperty({ type: ServiceVehicleGateView, nullable: true })
  exitedGate: ServiceVehicleGateView | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Closed by the system after GATE_UNCONFIRMED_EXIT_HOURS, not by a guard.',
  })
  exitUnconfirmed: boolean;

  static from(v: ServiceVehicleRecord): ServiceVehicleResponse {
    return {
      ...v,
      facility: v.facility ? { ...v.facility } : null,
      enteredGate: { ...v.enteredGate },
      exitedGate: v.exitedGate ? { ...v.exitedGate } : null,
    };
  }
}
