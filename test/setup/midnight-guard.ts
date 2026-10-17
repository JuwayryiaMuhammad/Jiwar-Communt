import { dbClock, midnightWait } from './compound-clock';

/**
 * No suite starts in the minutes around the compound's midnight: what its
 * set-up makes "today" stays today, for the server too, until its last
 * test. Once per suite, before its own set-up, never between its tests (a
 * wait there would carry the day's data into the next). At most eight
 * minutes, once in a run that crosses midnight.
 */
beforeAll(async () => {
  const ms = midnightWait(dbClock());
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}, 10 * 60_000);
