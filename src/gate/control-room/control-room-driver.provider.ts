import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { driverChoice } from '../vendors/vendor-call';
import {
  CONTROL_ROOM_DRIVER,
  OffControlRoomDriver,
} from './control-room-driver';
import { FakeControlRoomDriver } from './fake-control-room-driver';

/** The control-room driver this deployment runs (ADR 0068): the fake, or off. */
export const controlRoomDriverProvider: Provider = {
  provide: CONTROL_ROOM_DRIVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    driverChoice(config, 'control_room') === 'fake'
      ? new FakeControlRoomDriver()
      : new OffControlRoomDriver(),
};
