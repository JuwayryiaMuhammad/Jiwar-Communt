import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
  Length,
  Max,
  ValidateNested,
  validate,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AppException } from '../errors';
import {
  toFieldErrors,
  validationException,
  withParams,
} from './validation-errors';

enum Kind {
  owner = 'owner',
  tenant = 'tenant',
}

class Item {
  @IsUUID()
  unitId: string;

  @IsEnum(Kind, withParams({ allowed: Object.values(Kind) }))
  kind: Kind;
}

class Sample {
  @IsString()
  @Length(2, 10, withParams({ min: 2, max: 10 }))
  name: string;

  @IsEmail()
  email: string;

  @IsPhoneNumber('EG')
  phone: string;

  @IsOptional()
  @IsInt()
  @Max(5)
  floor?: number;

  @ValidateNested({ each: true })
  @Type(() => Item)
  items: Item[];
}

async function fieldsFor(body: object) {
  const errors = await validate(plainToInstance(Sample, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return toFieldErrors(errors);
}

const valid = {
  name: 'Mona',
  email: 'mona@example.com',
  phone: '01012345678',
  items: [{ unitId: '01920000-0000-7000-8000-00000000000a', kind: 'owner' }],
};

describe('validation → field codes', () => {
  it('passes a valid body', async () => {
    expect(await fieldsFor(valid)).toEqual([]);
  });

  it('reports a missing value once, as FIELD_REQUIRED', async () => {
    const rest: Partial<typeof valid> = { ...valid };
    delete rest.name;
    expect(await fieldsFor(rest)).toEqual([
      { field: 'name', code: 'FIELD_REQUIRED' },
    ]);
  });

  it('maps constraints to codes, with params from the decorator', async () => {
    const fields = await fieldsFor({
      ...valid,
      name: 'x',
      email: 'nope',
      phone: '123',
      floor: 9,
    });
    expect(fields).toEqual([
      { field: 'name', code: 'INVALID_LENGTH', params: { min: 2, max: 10 } },
      { field: 'email', code: 'INVALID_EMAIL' },
      { field: 'phone', code: 'INVALID_PHONE' },
      { field: 'floor', code: 'INVALID_NUMBER' },
    ]);
  });

  it('prefers the type error over the length error', async () => {
    expect(await fieldsFor({ ...valid, name: 42 })).toEqual([
      { field: 'name', code: 'INVALID_TYPE' },
    ]);
  });

  it('reports unknown properties as FIELD_NOT_ALLOWED', async () => {
    expect(await fieldsFor({ ...valid, tenantId: 'x' })).toEqual([
      { field: 'tenantId', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('flattens nested paths', async () => {
    const fields = await fieldsFor({
      ...valid,
      items: [{ unitId: 'bad', kind: 'guest' }],
    });
    expect(fields).toEqual([
      { field: 'items.0.unitId', code: 'INVALID_UUID' },
      {
        field: 'items.0.kind',
        code: 'INVALID_VALUE',
        params: { allowed: ['owner', 'tenant'] },
      },
    ]);
  });

  it('builds a VALIDATION_FAILED AppException with an English message', async () => {
    const errors = await validate(
      plainToInstance(Sample, { ...valid, email: 'nope' }),
    );
    const ex = validationException(errors);
    expect(ex).toBeInstanceOf(AppException);
    expect(ex.getStatus()).toBe(400);
    const body = ex.getResponse() as { code: string; message: string };
    expect(body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'email', code: 'INVALID_EMAIL' }],
    });
    expect(body.message).toContain('email');
  });
});
