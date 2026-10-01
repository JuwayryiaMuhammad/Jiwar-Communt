import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import {
  CapabilitiesModule,
  HouseholdsModule,
  ResidentsModule,
  UnitsModule,
  WorkersModule,
} from './community';
import { AccessModule } from './core/access/access.module';
import { PermissionsGuard } from './core/access/permissions.guard';
import { AccountsModule } from './core/accounts/accounts.module';
import { AppController } from './app.controller';
import { AuditModule } from './core/audit/audit.module';
import { AuthModule } from './core/auth/auth.module';
import { RequestContextModule } from './core/common/cls/request-context.module';
import { AllExceptionsFilter } from './core/common/filters/all-exceptions.filter';
import { httpLogOptions } from './core/common/logging/http-log-options';
import { JwtAuthGuard } from './core/common/guards/jwt-auth.guard';
import { validateEnv, type Env } from './core/config/env.schema';
import { DatabaseModule } from './core/database/database.module';
import { HealthModule } from './core/health/health.module';
import { MailModule } from './core/mail/mail.module';
import { NotificationsModule } from './core/notifications/notifications.module';
import { SweepModule } from './core/sweep/sweep.module';
import { PlatformModule } from './core/platform/platform.module';
import { RedisModule } from './core/redis/redis.module';
import { TenantSettingsModule } from './core/tenant-settings/tenant-settings.module';

@Module({
  imports: [
    // Entry points (main.ts, seed, tests) load .env themselves; the module
    // validates process.env only, so tests fully control configuration.
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const env = config.get('NODE_ENV', { infer: true });
        return {
          pinoHttp: httpLogOptions({
            level: config.get('LOG_LEVEL', { infer: true }),
            env,
          }),
        };
      },
    }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request & { id?: string }) => req.id ?? randomUUID(),
        // Request origin for audit entries and security events. req.ip
        // honours TRUST_PROXY (configureApp).
        setup: (cls, req: Request) => {
          cls.set('ip', req.ip);
          const ua = req.headers['user-agent'];
          cls.set(
            'userAgent',
            typeof ua === 'string' ? ua.slice(0, 512) : undefined,
          );
        },
      },
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        // Tenant tokens only; platform tokens use another secret and
        // audience (ADR 0011).
        signOptions: { algorithm: 'HS256', audience: 'tenant' },
        verifyOptions: { algorithms: ['HS256'], audience: 'tenant' },
      }),
    }),
    RequestContextModule,
    DatabaseModule,
    RedisModule,
    AccessModule,
    AuditModule,
    MailModule,
    SweepModule,
    TenantSettingsModule,
    HealthModule,
    AuthModule,
    AccountsModule,
    NotificationsModule,
    UnitsModule,
    PlatformModule,
    ResidentsModule,
    HouseholdsModule,
    WorkersModule,
    CapabilitiesModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: authentication fills the context the permission check
    // reads.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
