// Public surface of the gate domain (ADR 0015). Other domains import gate
// only from here; everything else in src/gate/ is internal.
export { GateModule } from './gate.module';
export { GateStatusPortModule } from './gate-status-port.module';
export { GateStatusPort, type GateStatus } from './gate-status-port';
export {
  GatePartnersPort,
  type ServicePass,
  type ServicePassInput,
  type ServicePassResult,
} from './gate-partners-port';
