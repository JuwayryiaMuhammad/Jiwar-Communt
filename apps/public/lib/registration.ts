/** The registration form as typed; every value is a string or a flag. */
export type RegistrationForm = {
  fullName: string;
  unitCode: string;
  phone: string;
  email: string;
  idDocumentType: 'national_id' | 'passport';
  idDocumentNumber: string;
  nationality: string;
  birthDate: string;
  occupancyType: 'owner' | 'tenant';
  resides: boolean;
  unitType: string;
  areaSqm: string;
  building: string;
};

export const emptyForm: RegistrationForm = {
  fullName: '',
  unitCode: '',
  phone: '',
  email: '',
  idDocumentType: 'national_id',
  idDocumentNumber: '',
  nationality: '',
  birthDate: '',
  occupancyType: 'owner',
  resides: true,
  unitType: '',
  areaSqm: '',
  building: '',
};

export type RegistrationBody = Readonly<Record<string, string | boolean>>;

/**
 * The body of POST /registrations/start. The code the API emails is bound
 * to this exact request, so the same frozen object is sent again, with the
 * code, to /registrations/complete: nothing typed afterwards can change it.
 *
 * Optional fields left empty are omitted, as are the passport-only fields
 * for a national ID (the API refuses a nationality other than EG there).
 */
export function registrationBody(
  linkToken: string,
  form: RegistrationForm,
  preferredLocale: 'ar' | 'en',
): RegistrationBody {
  const passport = form.idDocumentType === 'passport';
  const body: Record<string, string | boolean> = {
    linkToken,
    fullName: form.fullName.trim(),
    unitCode: form.unitCode.trim(),
    phone: form.phone.trim(),
    email: form.email.trim(),
    idDocumentType: form.idDocumentType,
    idDocumentNumber: form.idDocumentNumber.trim(),
    occupancyType: form.occupancyType,
    // A tenant lives in the unit; only an owner may say otherwise.
    resides: form.occupancyType === 'tenant' ? true : form.resides,
    preferredLocale,
  };
  if (passport) {
    body.nationality = form.nationality.trim().toUpperCase();
    body.birthDate = form.birthDate.trim();
  }
  for (const key of ['unitType', 'areaSqm', 'building'] as const) {
    const value = form[key].trim();
    if (value) body[key] = value;
  }
  return Object.freeze(body);
}

export function completionBody(start: RegistrationBody, code: string): RegistrationBody {
  return Object.freeze({ ...start, code });
}

/** Six ASCII digits, whatever keyboard typed them (Arabic-Indic included). */
export function normalizeCode(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '')
    .slice(0, 6);
}

export const isCode = (code: string) => /^\d{6}$/.test(code);
