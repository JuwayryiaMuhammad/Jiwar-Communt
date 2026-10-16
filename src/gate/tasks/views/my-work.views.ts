import { ApiProperty } from '@nestjs/swagger';
import { StaffGateServiceView } from '../../gate-services/views/gate-service.views';
import { StaffParkingReportView } from '../../parking-reports/views/parking-report.views';
import { GuardTaskView } from './task.views';

export class MyTasksSection {
  @ApiProperty({
    type: [GuardTaskView],
    description: 'Due first, then oldest.',
  })
  data: GuardTaskView[];
  @ApiProperty({
    type: Number,
    description: 'All of them, beyond the 50 shown.',
  })
  total: number;
}

export class MyGateServicesSection {
  @ApiProperty({ type: [StaffGateServiceView] })
  data: StaffGateServiceView[];
  @ApiProperty({ type: Number })
  total: number;
}

export class MyParkingReportsSection {
  @ApiProperty({ type: [StaffParkingReportView], description: 'Oldest first.' })
  data: StaffParkingReportView[];
  @ApiProperty({ type: Number })
  total: number;
}

/**
 * A guard's work in one place (ADR 0050): the guards' tasks, the gate
 * services residents asked for (ADR 0047) and the wrong-parking reports
 * (ADR 0045), as their own routes show them; each acted on there.
 */
export class MyWorkView {
  @ApiProperty({ type: Boolean, description: 'Whether I am on shift now.' })
  onShift: boolean;
  @ApiProperty({
    type: MyTasksSection,
    description:
      'Mine, my post’s while on shift there, and those I took: open or in progress (`/gate/tasks/{id}`).',
  })
  tasks: MyTasksSection;
  @ApiProperty({
    type: MyGateServicesSection,
    nullable: true,
    description:
      'The open requests, oldest first (`/gate/gate-services`). Null off shift.',
  })
  gateServiceQueue: MyGateServicesSection | null;
  @ApiProperty({
    type: MyGateServicesSection,
    nullable: true,
    description: 'The requests I accepted, not closed yet. Null off shift.',
  })
  myGateServices: MyGateServicesSection | null;
  @ApiProperty({
    type: MyParkingReportsSection,
    nullable: true,
    description:
      'The open wrong-parking reports (`/staff/parking-reports`), for a holder of `parking_reports.handle`; null otherwise.',
  })
  parkingReports: MyParkingReportsSection | null;
}
