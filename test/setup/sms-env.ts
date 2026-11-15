/**
 * Turns the in-memory SMS provider on for one suite (ADR 0095). Import it
 * FIRST in a spec, before anything that loads AppModule: the configuration
 * is read when AppModule is imported, and test-env.ts has set SMS_PROVIDER
 * to `none` for every other suite. Jest gives each spec file its own
 * process.env, so this never leaks into another suite.
 */
process.env.SMS_PROVIDER = 'log';
