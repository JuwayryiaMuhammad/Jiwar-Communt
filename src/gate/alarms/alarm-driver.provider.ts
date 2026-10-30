import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { driverChoice } from '../vendors/vendor-call';
import { ALARM_DRIVER, OffAlarmDriver } from './alarm-driver';
import { FakeAlarmDriver } from './fake-alarm-driver';

/** The guard-down driver this deployment runs (ADR 0068): the fake, or off. */
export const alarmDriverProvider: Provider = {
  provide: ALARM_DRIVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    driverChoice(config, 'alarm') === 'fake'
      ? new FakeAlarmDriver()
      : new OffAlarmDriver(),
};
