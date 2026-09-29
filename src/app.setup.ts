import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { Env } from './core/config/env.schema';
import { validationException } from './core/common/validation/validation-errors';

export const API_PREFIX = 'api/v1';

/**
 * Everything main.ts applies to the app besides listening. Shared with the
 * e2e tests so they exercise the same pipes, prefix and headers.
 */
export function configureApp(app: INestApplication): void {
  const isProd = process.env.NODE_ENV === 'production';

  app.use(
    helmet({
      // Allow Swagger UI assets outside production; it is disabled there.
      contentSecurityPolicy: isProd ? undefined : false,
    }),
  );

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : false,
    credentials: true,
  });

  // Client IP behind a reverse proxy: trust exactly TRUST_PROXY hops of
  // X-Forwarded-For, never the whole chain (ADR 0014).
  const trustProxy = app
    .get(ConfigService<Env, true>)
    .get('TRUST_PROXY', { infer: true });
  if (trustProxy) {
    const express = app.getHttpAdapter().getInstance() as {
      set(key: string, value: unknown): void;
    };
    express.set('trust proxy', trustProxy);
  }

  app.setGlobalPrefix(API_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Unknown fields are rejected, not stripped. This is what keeps
      // `tenantId` (or anything else the server owns) out of request bodies.
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationException,
    }),
  );

  if (!isProd) {
    const config = new DocumentBuilder()
      .setTitle('Jiwar API')
      .setDescription('Jiwar compound-management platform — Phase 0')
      .setVersion('0.1')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }
}
