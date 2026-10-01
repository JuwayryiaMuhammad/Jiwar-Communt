// Public surface of the community domain (ADR 0015). Other domains import
// community only from here; everything else in src/community/ is internal.
export { HouseholdsModule } from './households/households.module';
export { ResidentsModule } from './residents/residents.module';
export { ResidentsService } from './residents/residents.service';
export { UnitsModule } from './units/units.module';
export { WorkersModule } from './workers/workers.module';
export { WorkersService } from './workers/workers.service';
export { CapabilitiesModule } from './capabilities/capabilities.module';
export { CapabilitiesService } from './capabilities/capabilities.service';
export { CommunityGatePortModule } from './gate-port.module';
export { CommunityGatePort, type GateSchedule } from './gate-port';
export {
  capabilitiesFor,
  type Capabilities,
} from './capabilities/capabilities';
