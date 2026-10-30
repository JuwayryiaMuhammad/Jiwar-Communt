import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { driverChoice } from '../vendors/vendor-call';
import { FakeIdScanDriver } from './fake-id-scan-driver';
import { ID_SCAN_DRIVER, OffIdScanDriver } from './id-scan-driver';

/** The ID-scan driver this deployment runs (ADR 0068): the fake, or off. */
export const idScanDriverProvider: Provider = {
  provide: ID_SCAN_DRIVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    driverChoice(config, 'id_scan') === 'fake'
      ? new FakeIdScanDriver()
      : new OffIdScanDriver(),
};
