import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionBody, emptyForm, isCode, normalizeCode, registrationBody, type RegistrationForm } from './registration.ts';

const form = (over: Partial<RegistrationForm> = {}): RegistrationForm => ({
  ...emptyForm,
  fullName: '  Mona Adel ',
  unitCode: ' A-101 ',
  phone: '01001234567',
  email: ' mona@example.com ',
  idDocumentNumber: '29001011234567',
  ...over,
});

test('a national ID sends no nationality or birth date, and no empty optionals', () => {
  assert.deepEqual(registrationBody('tok', form({ nationality: 'SA', birthDate: '1990-01-01' }), 'ar'), {
    linkToken: 'tok',
    fullName: 'Mona Adel',
    unitCode: 'A-101',
    phone: '01001234567',
    email: 'mona@example.com',
    idDocumentType: 'national_id',
    idDocumentNumber: '29001011234567',
    occupancyType: 'owner',
    resides: true,
    preferredLocale: 'ar',
  });
});

test('a passport sends nationality and birth date; optionals when filled', () => {
  const body = registrationBody(
    'tok',
    form({
      idDocumentType: 'passport',
      idDocumentNumber: 'a1234567',
      nationality: ' sa ',
      birthDate: '1990-01-01',
      unitType: 'villa',
      areaSqm: ' 120.5 ',
      building: ' B ',
    }),
    'en',
  );
  assert.equal(body.nationality, 'SA');
  assert.equal(body.birthDate, '1990-01-01');
  assert.equal(body.unitType, 'villa');
  assert.equal(body.areaSqm, '120.5');
  assert.equal(body.building, 'B');
  assert.equal(body.preferredLocale, 'en');
});

test('a tenant always resides; an owner chooses', () => {
  assert.equal(registrationBody('t', form({ occupancyType: 'tenant', resides: false }), 'ar').resides, true);
  assert.equal(registrationBody('t', form({ occupancyType: 'owner', resides: false }), 'ar').resides, false);
});

test('complete repeats the start body exactly, plus the code', () => {
  const typed = form();
  const start = registrationBody('tok', typed, 'ar');
  // The person keeps typing and switches language after the code was sent.
  typed.fullName = 'Someone Else';
  typed.email = 'other@example.com';
  const complete = completionBody(start, '123456');
  const { code, ...rest } = complete;
  assert.equal(code, '123456');
  assert.deepEqual(rest, start);
  assert.equal(rest.fullName, 'Mona Adel');
  assert.equal(JSON.stringify(rest), JSON.stringify(start));
  assert.ok(Object.isFrozen(start) && Object.isFrozen(complete));
  assert.throws(() => {
    (start as Record<string, unknown>).email = 'x';
  }, TypeError);
});

test('a code is six ASCII digits from any digit keyboard', () => {
  assert.equal(normalizeCode('12 34-56'), '123456');
  assert.equal(normalizeCode('١٢٣٤٥٦'), '123456');
  assert.equal(normalizeCode('۱۲۳۴۵۶'), '123456');
  assert.equal(normalizeCode('1234567'), '123456');
  assert.equal(isCode('123456'), true);
  assert.equal(isCode('12345'), false);
  assert.equal(isCode('١٢٣٤٥٦'), false);
});
