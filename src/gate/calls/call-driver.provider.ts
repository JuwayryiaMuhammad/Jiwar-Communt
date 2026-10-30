import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { driverChoice } from '../vendors/vendor-call';
import { CALL_DRIVER, OffCallDriver } from './call-driver';
import { FakeCallDriver } from './fake-call-driver';

/** The call driver this deployment runs (ADR 0068): the fake, or off. */
export const callDriverProvider: Provider = {
  provide: CALL_DRIVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    driverChoice(config, 'call') === 'fake'
      ? new FakeCallDriver()
      : new OffCallDriver(),
};
