/**
 * Step 1 of `pnpm api-docs`: reads, from the controllers' own decorators, what
 * the OpenAPI file does not carry for each route: the permissions it needs,
 * whether it is public or a platform route, and what it is guarded by.
 *
 * Like `openapi.cli.ts` it builds the module graph in preview mode, so no
 * database, Redis or SMTP is needed. Usage:
 *   ts-node --transpile-only scripts/api-docs/extract-routes.ts <out.json>
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { API_PREFIX } from '../../src/app.setup';
import { ErrorCode, FieldErrorCode } from '../../src/core/common/errors';
import { PERMISSIONS } from '../../src/core/access/permissions';
import { DEFAULT_ROLES } from '../../src/core/access/default-roles';
import {
  ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from '../../src/core/access/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../../src/core/common/guards/public.decorator';
import { PLATFORM_ROUTE_KEY } from '../../src/core/common/guards/platform-route.decorator';

type Ctor = { name: string; prototype: Record<string, unknown> };

// Nest's internal metadata keys (stable: they are the strings the framework
// itself reads).
const PATH = 'path';
const METHOD = 'method';
const GUARDS = '__guards__';
const METHODS: Record<number, string> = {
  0: 'get',
  1: 'post',
  2: 'put',
  3: 'delete',
  4: 'patch',
  5: 'all',
  6: 'options',
  7: 'head',
};

function meta<T>(key: string, handler: object, cls: object): T | undefined {
  // Same rule as Reflector.getAllAndOverride: the method wins over the class.
  const own = Reflect.getMetadata(key, handler) as T | undefined;
  return own !== undefined
    ? own
    : (Reflect.getMetadata(key, cls) as T | undefined);
}

function segments(...parts: (string | string[] | undefined)[]): string {
  const flat: string[] = [];
  for (const p of parts) {
    for (const one of Array.isArray(p) ? p : [p]) {
      if (one && one !== '/') flat.push(one.replace(/^\/+|\/+$/g, ''));
    }
  }
  return '/' + flat.filter(Boolean).join('/');
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('usage: extract-routes.ts <out.json>');

  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix(API_PREFIX);

  const container = (
    app as unknown as {
      container: {
        getModules(): Map<
          string,
          { controllers: Map<unknown, { metatype?: Ctor }> }
        >;
      };
    }
  ).container;

  const routes: Record<string, unknown>[] = [];
  const seen = new Set<Ctor>();
  for (const mod of container.getModules().values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype;
      if (!cls || seen.has(cls)) continue;
      seen.add(cls);
      const base = Reflect.getMetadata(PATH, cls) as
        string | string[] | undefined;
      const classGuards = (Reflect.getMetadata(GUARDS, cls) ?? []) as {
        name: string;
      }[];
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        const handler = cls.prototype[name] as object;
        if (typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH, handler) as
          string | string[] | undefined;
        const method = Reflect.getMetadata(METHOD, handler) as
          number | undefined;
        if (sub === undefined || method === undefined) continue;
        const handlerGuards = (Reflect.getMetadata(GUARDS, handler) ?? []) as {
          name: string;
        }[];
        const platform = meta<unknown>(PLATFORM_ROUTE_KEY, handler, cls);
        const idem = meta<unknown>('idempotent:secret', handler, cls);
        for (const one of Array.isArray(sub) ? sub : [sub]) {
          const path = ('/' + API_PREFIX + segments(base, one))
            .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
            .replace(/(.)\/+$/, '$1');
          routes.push({
            method: METHODS[method] ?? String(method),
            path,
            controller: cls.name,
            handler: name,
            public: meta<boolean>(IS_PUBLIC_KEY, handler, cls) === true,
            platform: platform !== undefined,
            platformAllowsPasswordChange:
              typeof platform === 'object' && platform !== null
                ? (platform as { allowPasswordChange?: boolean })
                    .allowPasswordChange === true
                : false,
            all: meta<string[]>(REQUIRED_PERMISSIONS_KEY, handler, cls) ?? [],
            any: meta<string[]>(ANY_PERMISSIONS_KEY, handler, cls) ?? [],
            idempotent: idem !== undefined,
            idempotentSecret: idem === true,
            guards: [...classGuards, ...handlerGuards].map((g) => g.name),
          });
        }
      }
    }
  }
  await app.close();

  const file = resolve(process.cwd(), out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        routes,
        // The catalog the audience rules read: which account kinds may hold a
        // permission, and which default role holds it (ADR 0010).
        permissions: Object.fromEntries(
          Object.entries(PERMISSIONS).map(([key, def]) => [
            key,
            {
              kinds: [...def.kinds],
              derived: 'derived' in def && def.derived === true,
            },
          ]),
        ),
        // Every code the API can answer with (ADR 0013).
        errorCodes: Object.values(ErrorCode),
        fieldErrorCodes: Object.values(FieldErrorCode),
        roles: DEFAULT_ROLES.map((r) => ({
          key: r.key,
          kind: r.kind,
          permissions: [...r.permissions],
        })),
      },
      null,
      1,
    ),
  );
  console.log(`Read ${routes.length} routes from ${seen.size} controllers`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
