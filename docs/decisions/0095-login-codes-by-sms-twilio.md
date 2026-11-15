# 0095 — Login codes by SMS (Twilio): a login typed as a phone gets its code by text to that phone, through Twilio Programmable Messaging called with `fetch`; an email login and every other code stay on email; a text that fails, a number outside Egypt and a cap hit all fall back to email silently; an unknown phone gets nothing; one code to a phone unlocks the accounts behind that phone in every compound

**Status:** Accepted · Login codes by SMS · amends ADR 0004 (the second channel exists), 0009 (#3 closed for login, #13 still open), 0014 (three security events), 0019 (the outbox's SMS channel is still to come, the sender port is not), 0023 (what a recycled number now means), 0028 (guards and technicians can log in without an email)

## Context

ADR 0004 put delivery behind `OtpChannel` so SMS could be added later, and ADR 0009 #3 kept that open: field staff may not read email on shift. Today every login code goes by email to each distinct address behind the matched accounts. The owner decided on 2026-11-15:

1. **Only a login typed as a phone goes by SMS**, to that phone. An email login goes by email as today. Every other purpose (`invite_accept`, `registration`, `step_up`, `contact_change`, `proxy_accept`) stays on email, unchanged.
2. **If the SMS fails** (Twilio errors, times out or rejects the number) the code falls back to email, to the matched accounts' emails, exactly as today. The failure is recorded. The HTTP response never shows which way the code went, or that anything failed.
3. **Egypt only.** SMS goes only to numbers in an allow-list of country codes from the environment, default `+20`. A phone outside it takes the email path, as if SMS were off.

## Decisions

### Twilio Programmable Messaging, not Twilio Verify

Our code, our hashing, our attempt budget, rate limits and audit stay exactly as they are (ADR 0004, 0014); Twilio only carries the text. Verify would own the code, the attempts and the expiry, and could not be audited or limited by us.

- **The call** is `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`, form-encoded `To`, `MessagingServiceSid`, `Body` and `ValidityPeriod` (the code's lifetime: Twilio drops a text still queued after it), made with `fetch`. **No new npm dependency**, no SDK (the same choice as push, ADR 0041, and Paymob, ADR 0046).
- **Auth is an API key** (`TWILIO_API_KEY_SID` `SK…` and `TWILIO_API_KEY_SECRET`, basic auth), not the account's auth token: a key can be revoked or rotated alone, without touching the account's master credential. The Account SID is still in the URL. The auth token is not supported at all, so there is one way to configure it and nothing broader than needed to leak.
- **The sender is a Messaging Service** (`TWILIO_MESSAGING_SERVICE_SID` `MG…`), never a `From` in code: the owner changes the number, or switches to an alphanumeric sender ID, in Twilio's console and nothing here moves.
- **Timeout** `SMS_REQUEST_TIMEOUT_MS`, default 5000 (1000 to 15000). **At most one retry** inside a request, and only when the first attempt provably did not reach Twilio (connection never made: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, a connect timeout) or Twilio answered 429 or 503 (it took nothing), after 300 ms. **A timeout is never retried**: the text may be on its way, and two texts cost twice and confuse. A 500 is not retried either, for the same reason.
- **What a result carries** is a kind and a code, never Twilio's message: `number` (the destination was refused: Twilio 21211, 21214, 21217, 21401, 21407, 21421, 21610 opted out, 21612, 21614 not a mobile), `rejected` (our account: credentials, a region not enabled such as 21408, an unapproved sender, a quota), `unavailable` (not sent) and `unknown` (a timeout). The code is `TWILIO_<n>` from the error body's numeric `code`, or `HTTP_<status>`, or a Node network code. **Twilio's error body may echo the number, so its message and `more_info` are never read into a result, an event or a log**; a test feeds one that does and checks.

### The SMS port: `SmsSender`

`src/core/sms/` holds `SmsSender` (`send({ to, body, validitySeconds? }) → { ok } | { ok: false, kind, code }`, answering and not throwing, like the push transport), the token `SMS_SENDER`, `TwilioSmsSender`, `LogSmsSender`, and a global `SmsModule` that binds one of them by `SMS_PROVIDER`, or `null` when off. It knows nothing about login codes, so **worker notices (ADR 0009 #8) and WhatsApp can reuse it later**; neither is built here, and the outbox's channel column (ADR 0019) is still to come.

The login code reaches it through the existing seam: `OtpChannel` stays the interface, `EmailOtpChannel` stays `OTP_CHANNEL`, and `SmsOtpChannel` (`SMS_OTP_CHANNEL`, `to` a phone) renders the text and throws an `SmsDeliveryError` (kind and code only) when the sender did not take it. It sends only the `login` purpose.

### Configuration

| Variable | Default | |
|---|---|---|
| `SMS_PROVIDER` | `none` | `none`: SMS is off, everything goes by email as before, so staging and production keep working until the owner adds the secrets. `log`: development and tests, never sends. `twilio`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID` | unset | All four required with `twilio`: the app **refuses to start**, naming each missing one. Shapes are checked (`AC`/`SK`/`MG` plus 32 hex, a secret of 16 characters or more). Empty means unset. |
| `SMS_ALLOWED_COUNTRY_CODES` | `+20` | Comma separated calling codes (`+20,+966`). Matched against the number's parsed calling code, not a string prefix. |
| `SMS_MAX_PER_PHONE_PER_DAY` | 10 | See the caps. |
| `SMS_MAX_PER_HOUR` | 300 | See the caps. A guess for a pilot compound: three hundred codes an hour is a few thousand residents logging in at once. Raise it with the compounds. |
| `SMS_REQUEST_TIMEOUT_MS` | 5000 | |

- **`log` is refused when `NODE_ENV=production`**: a server that "sends" and delivers nothing would lock everyone out, and no fallback would follow.
- **`OTP_FIXED_CODE`'s production guard is unchanged and still holds** (a test pins it with Twilio configured).
- **`log` keeps the texts in memory** (`LogSmsSender.messages()`, the newest 500), which the e2e tests read the way they read Mailpit for email (`test/setup/sms.ts`), and writes one log line with the number masked (`+20********78`) that a developer can read the code from. In-process is the simplest design that fits: the tests run the app in their own process.
- **In the test environment SMS is `none`** (`test/setup/test-env.ts`), whatever a developer's `.env` says, and the `TWILIO_*` variables are removed: no suite can reach Twilio, and the existing suites that log in by phone through Mailpit keep their meaning. The SMS suite turns `log` on for itself (`test/setup/sms-env.ts`, imported first). The default in the owner's brief was `log` for every suite; this keeps the same safety with no change to other suites.

### Who gets a text, and who does not

A code goes by SMS when **all** hold: the identifier was typed as a phone; **at least one active account in an active compound has that phone as a login identifier** (an unknown phone gets no text, below); the provider is not `none`; the phone's calling code is allowed; and neither cap is hit. Otherwise it goes by email exactly as before. A phone outside the allowed countries is treated as if SMS were off: no event, no counter.

**An unknown phone gets no SMS. Decided: no.** We never pay for or spam a number that has no account. The response stays identical (always `202 OTP_REQUESTED`, same body), the work runs after it as before, and the request limits per identifier and per IP count unknown phones too. A test compares the bytes of the three responses and checks that the unknown number received nothing and nothing was recorded for it but `otp.requested` with zero destinations.

### The challenge model for a phone

- **One challenge to the phone.** Its code unlocks every active account whose login identifier is that phone, **across compounds**: holding the phone is the proof, so it does not matter which email each account has, or whether it has one. This is the one place the rule of ADR 0004 ("one challenge per distinct destination email") changes: the destination is the phone.
- **Two compounds on one phone** (the person's, or a family's): one text, one code, and `/auth/otp/verify` lists both accounts, as the email path did with one shared email. With different emails, the email path sent two codes and each unlocked one account; the SMS path sends one and unlocks both. That is what the owner chose.
- **What a code unlocks stays what it was sent to.** The challenge row keeps the identifier hash it was issued for, and `verify` lists only login identifiers with that hash and the challenge's account ids. So **a code sent to a phone never unlocks an account reached only through an email, and the reverse**: a person with two accounts that share an email but not a phone gets both from the email's code and only the one from that phone's code, and neither code works under the other identifier (a test).
- **A newer request ends the older codes**, by the same id-order rule as before, SMS or email: the newest request leaves exactly its own code live. The same attempt budget applies (5 wrong guesses burn the code, `otp.challenge_exhausted`).
- **The fallback.** When the text did not go, the challenge to the phone is ended (a refusal means the code never left) and the codes go by email, one per distinct email behind the matched accounts, exactly as today. **One exception**: after a timeout (`unknown`) the text may still arrive, so its challenge stays live beside the emailed ones until the next request ends it. Accounts with no email are reached by SMS only: with the SMS failed and nobody to email, nothing is sent (`fallback: none` in the event).
- The number is passed in memory from the request to `OtpService.issue` and used for that one call. It is **never stored, logged or recorded**: not in the challenge row, not in Redis (the caps use the identifier hash), not in an event.

### Cost and abuse (SMS pumping)

SMS pumping needs an attacker to make the service text numbers they profit from. Here an SMS goes only to a number with an account (never to an unknown one), and the existing limits stay (5 requests per identifier hash per 15 minutes, 20 per IP, counted for unknown identifiers too). On top:

- **`SMS_MAX_PER_PHONE_PER_DAY`** (default 10): a fixed 24-hour window per identifier hash, `rl:sms:phone:<hash>`.
- **`SMS_MAX_PER_HOUR`** (default 300): one fixed hour window for the whole service, `rl:sms:global`.
- Both are Redis counters like the other limits (`RateLimitService.hit`); **every attempt counts, whether or not Twilio took it** (it may have billed). The number's cap is checked first, so a number past its cap does not spend the service's budget.
- **Past a cap the code goes by email silently** and `otp.sms_capped` is recorded with the cap (`phone_daily` or `global_hourly`). A cap is not a 429: the user still gets a code.
- An alert on `otp.sms_capped` and `otp.sms_failed` (the admin dashboard lists them as alerting) is how the owner learns that a cap is too low, that Twilio's geo permissions are wrong, or that someone is probing.

### The text

One segment where possible (ADR 0013): Arabic is UCS-2, so 70 characters; the English fits GSM-7's 160. The language is the request's locale (`Accept-Language`, default Arabic), as with the email, and the code is always ASCII digits.

- ar: `جوار: رمز الدخول 123456. صالح 5 دقائق. لا تشاركه مع أحد.` (about 57 characters; a test holds every lifetime from 1 to 30 minutes to 70.)
- en: `Jiwar: your login code is 123456. It expires in 5 minutes. Do not share it.`

The text names no tenant, account, link or app hash. The texts live with the other OTP texts (`src/core/auth/otp-sms.templates.ts`).

### Audit (amends ADR 0014)

Three security events, written in the background so a slow insert never delays the fallback, with the identifier hash and never the number:

| Event | When | Metadata |
|---|---|---|
| `otp.sms_sent` | the text was taken by the provider | `locale` |
| `otp.sms_failed` | the text was not taken | `locale`, `reason` (`number`, `rejected`, `unavailable`, `unknown`), `code` (a Twilio or network code), `fallback` (`email` or `none`) |
| `otp.sms_capped` | a cap held the text back | `locale`, `cap` |

`otp.requested` is still written once per request, with `channel: 'sms'` and `destinations: 1` when the text went, and with `{ locale, destinations }` unchanged on the email path (also after a fallback, where it follows `otp.sms_failed`). The admin dashboard's catalog and Arabic/English labels know the three.

## Assumptions and risks, recorded on purpose

- **A phone on an account is now a credential.** With email delivery the typed phone only found the account; the proof was the inbox the account named. Now the phone is the proof. A phone a manager mistyped, or one that nobody verified, sends a code to a stranger who can log in as that account. Accounts today take their phone from the manager's or the registrant's form, unverified by a code. **Open, and the first thing to decide next**: confirm a phone with a code on its first use (or when it is set), before an account can log in by SMS.
- **A recycled number reaches the old account until "not me" exists.** ADR 0023 observed that with email, the new holder of a number could never reach the old account. With SMS they can, if the old holder never changed the number on the account. Freezing and releasing a number are still staff actions today; the self-service "not me" (ADR 0009 #13) is not built here and is now more pressing. The cap, the five-attempt budget and the existing rate limits bound it; they do not remove it.
- **The text is as private as the phone's lock screen.** The code is short-lived (5 minutes) and single use, and the text says not to share it.
- **No SMS autofill hash** (Android's SMS Retriever 11-character app hash, or iOS's `@domain #code` form) is added: it needs the app's signing key and the domain, and neither is decided. **Open.**
- **Twilio delivery receipts** (a status callback) are not used. "Taken by Twilio" is the success: a number that Twilio accepts and the carrier drops looks like a success, and the user asks again. A callback route would need its signature check and a table; **open**, with the outbox's SMS channel (ADR 0019).
- **`ValidityPeriod`** is the code's lifetime in seconds; Twilio documents it for the Messages resource, but this has not been run against a live account. Remove it from `twilio-sms.sender.ts` if Twilio refuses it.
- **Idempotency.** A retry after a timeout is never sent, and a request that timed out may duplicate nothing; Twilio's idempotency header is not used.
- **Alphanumeric sender IDs** are subject to Egyptian carrier registration. Whatever sender the Messaging Service holds is the owner's decision in Twilio.

## What this unblocks

- **Guards and technicians can log in without an email** (ADR 0028, ADR 0009 #3 closed for login): a staff account whose only contact is a phone reaches its code by SMS. Creating accounts without an email is a later change of its own (an account still requires one today).
- **The self-service "not me"** (ADR 0023, ADR 0009 #13): the new holder of a number can now receive a code, so the reassignment can be asked for by SMS code. Not built here.
- **Worker notices and WhatsApp** (ADR 0009 #8, ADR 0019): `SmsSender` is the port; a notice needs the outbox's channel, retries and quiet hours, which are not built.

## Owner's setup

Done once in Twilio, then on the staging server. **None of it is needed to deploy this change**: with no `SMS_PROVIDER` the server behaves exactly as before.

1. **Twilio Console → Account → API keys & tokens → Create API key.** Type "Standard". Copy the **SID** (`SK…`) and the **secret** (shown once) into your password manager. From the console's home copy the **Account SID** (`AC…`).
2. **Twilio Console → Messaging → Services → Create Messaging Service** (use case: "Notify my users" or "Verify users"). Add a **sender**: a number that can send SMS to Egypt, or an alphanumeric sender ID (`Jiwar`) if Egyptian carriers' registration is done. Copy the service's **SID** (`MG…`).
3. **Twilio Console → Messaging → Settings → Geo permissions → enable Egypt** (and any country added to `SMS_ALLOWED_COUNTRY_CODES`). Without it Twilio answers 21408 and every code falls back to email; `otp.sms_failed` with `code: TWILIO_21408` is the sign.
4. **On the staging server**, in `/srv/jiwar-community/app.env` (root:jiwar-deploy 640, see `deploy/README.md`), add:

   ```
   SMS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC…
   TWILIO_API_KEY_SID=SK…
   TWILIO_API_KEY_SECRET=…
   TWILIO_MESSAGING_SERVICE_SID=MG…
   ```

   and optionally `SMS_ALLOWED_COUNTRY_CODES` (default `+20`), `SMS_MAX_PER_PHONE_PER_DAY` (10), `SMS_MAX_PER_HOUR` (300) and `SMS_REQUEST_TIMEOUT_MS` (5000). A changed `app.env` takes effect when the app container is recreated, which the next deploy does. If a variable is missing or malformed the app **will not start**, its log names the variable, and the deploy script puts the previous release back up.
5. **Check it:** ask for a login code with a phone of an account you control; the text should arrive in seconds. In the admin dashboard's security events, `otp.sms_sent` appears, and the phone never does. A first run from a trial Twilio account only texts numbers verified in the console.
6. **Never** put the key's secret in git, a chat, a log or the `.env.example`; to rotate, make a new key, change `TWILIO_API_KEY_*`, deploy (or recreate the app container), then delete the old key in Twilio.

## Consequences

- A phone login in Egypt gets a text; everything else, and every failure, is what it was. The response of `POST /auth/otp/request` is unchanged (`202 OTP_REQUESTED`), apart from its English developer message no longer saying "email on file" and the operation's summary.
- `POST /auth/otp/verify` is unchanged. A phone's code may list several accounts of several compounds at once.
- No migration, no new table, no new route, no new permission. Three security events and nine environment variables.
- Tests: unit (the Twilio request's shape with a mocked `fetch`, timeouts and errors, no number in a result; the channel choice for a phone, an email, a refused country and SMS off; the caps; the text's length; the env schema) and e2e with `SMS_PROVIDER=log` (`test/auth/sms-login.e2e-spec.ts`: a phone login by text, an email login, a foreign phone, a forced failure and a throwing sender falling back, an unknown phone, both caps, what a code unlocks, two compounds on one phone, the number never in an event).
