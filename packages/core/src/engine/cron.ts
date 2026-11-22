/**
 * @module cron
 *
 * Pure, zero-dependency parsing and next-fire-time computation for standard
 * 5-field cron expressions (`minute hour day-of-month month day-of-week`).
 *
 * Cron strings can originate from untrusted YAML, so this module is hardened
 * against ReDoS: the input length is bounded before any work happens, fields
 * are split with plain string operations, and integers are parsed character by
 * character — there are no backtracking regexes. Both exported functions are
 * stateless and safe to call concurrently.
 *
 * Supported grammar (v1): each field is a comma-separated list of terms. A term
 * is a star, a number N, a range A-B, a stepped star, or a stepped range A-B/S
 * (step S >= 1, ranges ascending). Names (JAN, MON), `@daily` macros, `N/S`,
 * `?`, `L`, `W`, `#` and a seconds field are not supported.
 */

import { CogniPipeError } from '../errors/CogniPipeError.js';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes.js';

/**
 * Which clock a schedule is evaluated against.
 * - `'utc'` — fields match UTC wall-clock time (the default everywhere).
 * - `'local'` — fields match the host process's local time zone. IANA time
 *   zones are intentionally out of scope for v1.
 *
 * @example
 * ```typescript
 * const next = nextCronRun(parseCron('0 9 * * *'), new Date(), 'local');
 * ```
 */
export type SchedulerTimezone = 'utc' | 'local';

/**
 * A parsed 5-field cron expression: one set of allowed values per field.
 * Produced by {@link parseCron}; consumed by {@link nextCronRun}.
 *
 * @example
 * ```typescript
 * const cron = parseCron('5-30/5 9 * * 1-5');
 * cron.minutes.has(30); // true
 * cron.dowRestricted; // true
 * ```
 */
export interface ParsedCron {
  /** Allowed minutes, 0-59. */
  readonly minutes: ReadonlySet<number>;
  /** Allowed hours, 0-23. */
  readonly hours: ReadonlySet<number>;
  /** Allowed days of month, 1-31. */
  readonly daysOfMonth: ReadonlySet<number>;
  /** Allowed months, 1-12. */
  readonly months: ReadonlySet<number>;
  /** Allowed days of week, 0-6 (0 = Sunday; an input `7` is accepted as Sunday). */
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when the day-of-month field was something other than `*`. */
  readonly domRestricted: boolean;
  /** True when the day-of-week field was something other than `*`. */
  readonly dowRestricted: boolean;
}

/** Hard input bound — enforced before any splitting or parsing work happens. */
const MAX_EXPRESSION_LENGTH = 256;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** How far ahead nextCronRun searches before giving up (e.g. "0 0 30 2 *"). */
const SEARCH_HORIZON_YEARS = 8;

/** Builds a SCHEDULE_INVALID error via the shared constant — never a raw string. */
function scheduleInvalid(message: string, context?: Record<string, unknown>): CogniPipeError {
  return new CogniPipeError(message, {
    code: COGNIPIPE_ERROR_CODES.SCHEDULE_INVALID,
    context,
  });
}

/**
 * Strict, regex-free non-negative integer parsing. Accepts only ASCII digits
 * (so `parseInt`-style looseness such as "12abc" or "+5" is rejected) and only
 * safe integers, so absurdly long digit runs fail fast instead of overflowing.
 */
function parseStrictInt(text: string): number | undefined {
  if (text.length === 0) {
    return undefined;
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      return undefined;
    }
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parses one comma-separated cron field into its set of allowed values.
 * Every error names the field and the offending value, per the engine's
 * actionable-error convention.
 *
 * @param normalizeSunday - When true, a value of 7 is stored as 0 (day-of-week only).
 */
function parseField(
  raw: string,
  name: string,
  min: number,
  max: number,
  expression: string,
  normalizeSunday = false,
): Set<number> {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const slashIndex = part.indexOf('/');
    const base = slashIndex === -1 ? part : part.slice(0, slashIndex);

    let step = 1;
    if (slashIndex !== -1) {
      const parsedStep = parseStrictInt(part.slice(slashIndex + 1));
      if (parsedStep === undefined || parsedStep < 1) {
        throw scheduleInvalid(
          `Cron field "${name}" has value "${part}" whose step is not an integer >= 1. Expression: "${expression}"`,
          { field: name, value: part, expression },
        );
      }
      step = parsedStep;
    }

    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else {
      const dashIndex = base.indexOf('-');
      if (dashIndex !== -1) {
        const lo = parseStrictInt(base.slice(0, dashIndex));
        const hi = parseStrictInt(base.slice(dashIndex + 1));
        if (lo === undefined || hi === undefined) {
          throw scheduleInvalid(
            `Cron field "${name}" has value "${part}" which is not a valid range of integers. Expression: "${expression}"`,
            { field: name, value: part, expression },
          );
        }
        if (lo < min || lo > max || hi < min || hi > max) {
          throw scheduleInvalid(
            `Cron field "${name}" has value "${part}" which is outside ${min}-${max}. Expression: "${expression}"`,
            { field: name, value: part, expression },
          );
        }
        if (lo > hi) {
          throw scheduleInvalid(
            `Cron field "${name}" has value "${part}" whose range is not ascending (A-B requires A <= B). Expression: "${expression}"`,
            { field: name, value: part, expression },
          );
        }
        start = lo;
        end = hi;
      } else {
        const value = parseStrictInt(base);
        if (value === undefined) {
          throw scheduleInvalid(
            `Cron field "${name}" has value "${part}" which is not a valid cron term. Expected a star, "N", "A-B" or "A-B/S" with integers in ${min}-${max}. Expression: "${expression}"`,
            { field: name, value: part, expression },
          );
        }
        if (value < min || value > max) {
          throw scheduleInvalid(
            `Cron field "${name}" has value "${part}" which is outside ${min}-${max}. Expression: "${expression}"`,
            { field: name, value: part, expression },
          );
        }
        if (slashIndex !== -1) {
          throw scheduleInvalid(
            `Cron field "${name}" has value "${part}" — "N/S" is not supported. Use "A-B/S" or a stepped star instead. Expression: "${expression}"`,
            { field: name, value: part, expression },
          );
        }
        start = value;
        end = value;
      }
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }

  return values;
}

/**
 * Parses a standard 5-field cron expression into one set of values per field.
 *
 * Grammar (v1): exactly 5 whitespace-separated fields —
 * `minute hour day-of-month month day-of-week`. Each field is a comma-separated
 * list of a star, `N`, `A-B`, a stepped star, or `A-B/S` (S >= 1, ranges
 * ascending). Day-of-week accepts `7` as Sunday. Expressions longer than 256
 * characters are rejected before any parsing work (ReDoS hardening — cron
 * strings may come from untrusted YAML).
 *
 * Day-of-month / day-of-week follow classic cron: when BOTH fields are
 * restricted (anything other than a bare `*`), a date matches when EITHER
 * matches; when only one is restricted, only that one applies.
 *
 * @param expression - The raw cron expression, e.g. `"0 9 * * 1-5"`.
 * @returns The parsed field sets plus the classic-cron restriction flags.
 * @throws {CogniPipeError} SCHEDULE_INVALID — the message names the offending
 *   field and value.
 *
 * @example
 * ```typescript
 * const cron = parseCron('0 0 1,15 * *');
 * cron.daysOfMonth; // Set { 1, 15 }
 * parseCron('60 * * * *'); // throws SCHEDULE_INVALID
 * ```
 */
export function parseCron(expression: string): ParsedCron {
  // Untrusted callers (YAML, JSON) can hand over a non-string at runtime.
  if (typeof expression !== 'string') {
    throw scheduleInvalid(
      `Cron expression must be a string, received ${expression === null ? 'null' : typeof expression}.`,
    );
  }

  // Reject over-long input BEFORE doing any work — this is the ReDoS guard.
  // The expression itself is deliberately not echoed back in this message.
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw scheduleInvalid(
      `Cron expression is too long: received ${expression.length} characters, maximum is ${MAX_EXPRESSION_LENGTH}.`,
      { length: expression.length },
    );
  }

  const trimmed = expression.trim();
  if (trimmed === '') {
    throw scheduleInvalid(
      'Cron expression is empty. Expected 5 whitespace-separated fields: minute hour day-of-month month day-of-week.',
    );
  }

  // `\s+` is a single linear quantifier with no nesting and the input is
  // already capped at 256 characters, so it cannot backtrack catastrophically.
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw scheduleInvalid(
      `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), received ${fields.length}. Expression: "${expression}"`,
      { expression },
    );
  }

  // The length was checked immediately above, so this tuple cast is safe.
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    minutes: parseField(minute, 'minute', 0, 59, expression),
    hours: parseField(hour, 'hour', 0, 23, expression),
    daysOfMonth: parseField(dayOfMonth, 'day-of-month', 1, 31, expression),
    months: parseField(month, 'month', 1, 12, expression),
    daysOfWeek: parseField(dayOfWeek, 'day-of-week', 0, 7, expression, true),
    domRestricted: dayOfMonth !== '*',
    dowRestricted: dayOfWeek !== '*',
  };
}

/**
 * Computes the first minute STRICTLY after `after` that matches the parsed
 * cron expression (seconds and milliseconds are always 0), or `undefined`
 * when nothing matches within an 8-year search horizon (e.g. `"0 0 30 2 *"`).
 *
 * Uses field-wise jumping (month, then day, then hour, then minute) instead of
 * scanning minute by minute, so sparse schedules such as `"0 0 29 2 *"`
 * resolve in microseconds even across non-leap years.
 *
 * In `'local'` mode the fields are matched against host-local wall-clock time.
 * The search runs on packed wall-clock values, so a DST shift can never corrupt
 * the cursor mid-search; only the final result is converted back to an instant.
 * Two DST consequences follow: a wall time inside a spring-forward gap fires at
 * the first instant after the gap, and the repeated hour of a fall-back is not
 * run twice. The returned instant is always strictly after `after`. IANA time
 * zones are out of scope.
 *
 * @param cron - A parsed expression from {@link parseCron}.
 * @param after - The instant to search strictly after.
 * @param timezone - `'utc'` (default) or `'local'`.
 * @returns The next matching Date, or `undefined` if none exists within 8 years.
 *
 * @example
 * ```typescript
 * const cron = parseCron('0 0 29 2 *');
 * nextCronRun(cron, new Date('2026-03-01T00:00:00Z'));
 * // → 2028-02-29T00:00:00.000Z (skips the non-leap year 2027)
 * ```
 */
export function nextCronRun(
  cron: ParsedCron,
  after: Date,
  timezone: SchedulerTimezone = 'utc',
): Date | undefined {
  // Pack `after`'s wall-clock fields (in the requested timezone) into a
  // pseudo-UTC timestamp. All search arithmetic then happens on this packed
  // value, where days, hours and minutes are exact multiples — no DST
  // transition can shift the cursor mid-search.
  const wall =
    timezone === 'utc'
      ? Date.UTC(
          after.getUTCFullYear(),
          after.getUTCMonth(),
          after.getUTCDate(),
          after.getUTCHours(),
          after.getUTCMinutes(),
        )
      : Date.UTC(
          after.getFullYear(),
          after.getMonth(),
          after.getDate(),
          after.getHours(),
          after.getMinutes(),
        );

  const horizonDate = new Date(wall);
  horizonDate.setUTCFullYear(horizonDate.getUTCFullYear() + SEARCH_HORIZON_YEARS);
  const horizon = horizonDate.getTime();

  // Packing dropped seconds and ms; +1 minute makes the search strictly after.
  let cursor = wall + MINUTE_MS;

  while (cursor <= horizon) {
    const candidate = new Date(cursor);

    if (!cron.months.has(candidate.getUTCMonth() + 1)) {
      // Jump straight to 00:00 on the 1st of the next month.
      cursor = Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 1);
      continue;
    }

    const domMatches = cron.daysOfMonth.has(candidate.getUTCDate());
    const dowMatches = cron.daysOfWeek.has(candidate.getUTCDay());
    // Classic cron: both restricted → OR; only one restricted → only it applies.
    const dayMatches =
      cron.domRestricted && cron.dowRestricted
        ? domMatches || dowMatches
        : cron.domRestricted
          ? domMatches
          : cron.dowRestricted
            ? dowMatches
            : true;
    if (!dayMatches) {
      // Jump to the next midnight.
      cursor = (Math.floor(cursor / DAY_MS) + 1) * DAY_MS;
      continue;
    }

    if (!cron.hours.has(candidate.getUTCHours())) {
      // Jump to the top of the next hour.
      cursor = (Math.floor(cursor / HOUR_MS) + 1) * HOUR_MS;
      continue;
    }

    if (cron.minutes.has(candidate.getUTCMinutes())) {
      const result =
        timezone === 'utc'
          ? candidate
          : new Date(
              candidate.getUTCFullYear(),
              candidate.getUTCMonth(),
              candidate.getUTCDate(),
              candidate.getUTCHours(),
              candidate.getUTCMinutes(),
            );
      // In local mode a fall-back overlap can resolve a wall time to the FIRST
      // of its two instants, which may not be after `after`. Returning it would
      // make a scheduler re-fire the same tick forever, so keep searching.
      if (result.getTime() > after.getTime()) {
        return result;
      }
    }

    cursor += MINUTE_MS;
  }

  return undefined;
}
