// Public surface of the maintenance domain (ADR 0015). Other domains import
// maintenance only from here; everything else in src/maintenance/ is internal.
export { MaintenanceModule } from './maintenance.module';
