/**
 * Jest global setup — pins the process time zone before any test worker starts.
 *
 * Several cron tests only run when the host zone observes daylight-saving time
 * (see the "DST transitions" block in cron.test.ts). Setting `process.env.TZ`
 * from inside a test file has no effect, because Jest gives every test file its
 * own copy of `process.env`. This file runs once in the parent process, so the
 * zone is inherited by every worker and the DST branches are exercised on any
 * machine, including UTC-only ones such as CI runners and Cloud Shell.
 */
import process from 'node:process';

export default async function globalSetup() {
  process.env.TZ = 'America/New_York';
}
