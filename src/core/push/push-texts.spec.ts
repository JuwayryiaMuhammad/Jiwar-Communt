import { LOCALES } from '../common/i18n/locale';
import {
  NOTIFICATION_KINDS,
  PERSONAL_PARAMS,
  type KindSpec,
  type NotificationKind,
  type NotificationParams,
} from '../notifications/kinds';
import { placeholders, PUSH_TEXTS, renderPush } from './push-texts';

const kinds = NOTIFICATION_KINDS as Record<string, KindSpec>;
const texts = PUSH_TEXTS as Record<
  string,
  Record<string, { title: string; body: string }>
>;

/** A value no text would contain by accident, per param. */
function sample(kind: string): NotificationParams {
  return Object.fromEntries(
    Object.keys(kinds[kind].params).map((name) => [name, `<<${name}>>`]),
  );
}

describe('push texts (ADR 0041)', () => {
  it('every kind has a text, and no text is for an unknown kind', () => {
    expect(Object.keys(texts).sort()).toEqual(Object.keys(kinds).sort());
  });

  it('every kind has a title and a body in Arabic and in English', () => {
    for (const kind of Object.keys(kinds)) {
      expect([kind, Object.keys(texts[kind]).sort()]).toEqual([
        kind,
        [...LOCALES].sort(),
      ]);
      for (const locale of LOCALES) {
        const { title, body } = texts[kind][locale];
        expect([kind, locale, title.trim().length > 0]).toEqual([
          kind,
          locale,
          true,
        ]);
        expect([kind, locale, body.trim().length > 0]).toEqual([
          kind,
          locale,
          true,
        ]);
        // What a lock screen shows before it cuts the text.
        expect([kind, locale, title.length <= 60]).toEqual([
          kind,
          locale,
          true,
        ]);
        expect([kind, locale, body.length <= 200]).toEqual([
          kind,
          locale,
          true,
        ]);
      }
    }
  });

  it('Arabic texts are written in Arabic, English ones are not', () => {
    const arabic = /[؀-ۿ]/;
    for (const kind of Object.keys(kinds)) {
      const strip = (s: string) => s.replace(/\{[A-Za-z]+\}/g, '');
      expect([kind, arabic.test(texts[kind].ar.title)]).toEqual([kind, true]);
      expect([kind, arabic.test(texts[kind].ar.body)]).toEqual([kind, true]);
      // No Latin words left untranslated in the Arabic.
      expect([
        kind,
        /[A-Za-z]{2,}/.test(strip(texts[kind].ar.title + texts[kind].ar.body)),
      ]).toEqual([kind, false]);
      expect([
        kind,
        arabic.test(texts[kind].en.title + texts[kind].en.body),
      ]).toEqual([kind, false]);
    }
  });

  it('a title has no placeholder; a body only names params the kind always carries', () => {
    for (const [kind, spec] of Object.entries(kinds)) {
      for (const locale of LOCALES) {
        expect([kind, locale, placeholders(texts[kind][locale].title)]).toEqual(
          [kind, locale, []],
        );
        for (const name of placeholders(texts[kind][locale].body)) {
          const param = spec.params[name] as
            { optional?: boolean; personal?: boolean } | undefined;
          expect([kind, locale, name, param !== undefined]).toEqual([
            kind,
            locale,
            name,
            true,
          ]);
          expect([kind, locale, name, param?.optional ?? false]).toEqual([
            kind,
            locale,
            name,
            false,
          ]);
        }
      }
    }
  });

  it('no personal param is ever named in a text', () => {
    expect(PERSONAL_PARAMS.length).toBeGreaterThan(0);
    for (const kind of Object.keys(kinds)) {
      for (const locale of LOCALES) {
        const { title, body } = texts[kind][locale];
        for (const name of PERSONAL_PARAMS)
          expect([kind, locale, placeholders(title + body)]).not.toEqual([
            kind,
            locale,
            expect.arrayContaining([name]),
          ]);
      }
    }
  });

  it('rendered text never contains the value of a personal param', () => {
    for (const [kind, spec] of Object.entries(kinds)) {
      const params = sample(kind);
      for (const locale of LOCALES) {
        const { title, body } = renderPush(
          kind as NotificationKind,
          locale,
          params,
        );
        for (const [name, param] of Object.entries(spec.params)) {
          if (!(param as { personal?: boolean }).personal) continue;
          expect([
            kind,
            locale,
            name,
            (title + body).includes(`<<${name}>>`),
          ]).toEqual([kind, locale, name, false]);
        }
      }
    }
  });

  it('renders every kind with its params, and with only the required ones', () => {
    for (const [kind, spec] of Object.entries(kinds)) {
      const full = sample(kind);
      const required = Object.fromEntries(
        Object.entries(full).filter(
          ([name]) =>
            !(spec.params[name] as { optional?: boolean }).optional &&
            !(spec.params[name] as { personal?: boolean }).personal,
        ),
      );
      for (const locale of LOCALES) {
        for (const params of [full, required]) {
          const { title, body } = renderPush(
            kind as NotificationKind,
            locale,
            params,
          );
          const text = `${title}\n${body}`;
          expect([kind, locale, /\{|\}|undefined|null/.test(text)]).toEqual([
            kind,
            locale,
            false,
          ]);
          for (const name of placeholders(texts[kind][locale].body))
            expect([kind, locale, name, body.includes(`<<${name}>>`)]).toEqual([
              kind,
              locale,
              name,
              true,
            ]);
        }
      }
    }
  });

  it('a param the stored notification lost renders as nothing', () => {
    expect(renderPush('parcel.arrived', 'en', {}).body).toBe(
      'A parcel for unit  is at the gate.',
    );
  });
});
