import { nextCronRun, parseCron } from '../../engine/cron';
import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

/** Asserts fn() throws a CogniPipeError with SCHEDULE_INVALID and returns it. */
function expectCronError(fn: () => unknown): CogniPipeError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }

  expect(isCogniPipeError(thrown)).toBe(true);
  const err = thrown as CogniPipeError;
  expect(err.code).toBe(COGNIPIPE_ERROR_CODES.SCHEDULE_INVALID);
  return err;
}

describe('parseCron', () => {
  describe('valid expressions', () => {
    it('parses a stepped star into quarter-hour minutes with unrestricted day flags', () => {
      const cron = parseCron('*/15 * * * *');
      expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
      expect(cron.hours.size).toBe(24);
      expect(cron.daysOfMonth.size).toBe(31);
      expect(cron.months.size).toBe(12);
      expect(cron.daysOfWeek.size).toBe(7);
      expect(cron.domRestricted).toBe(false);
      expect(cron.dowRestricted).toBe(false);
    });

    it('parses 0 9 * * 1-5 as weekdays at 09:00 with dowRestricted', () => {
      const cron = parseCron('0 9 * * 1-5');
      expect([...cron.minutes]).toEqual([0]);
      expect([...cron.hours]).toEqual([9]);
      expect([...cron.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
      expect(cron.dowRestricted).toBe(true);
      expect(cron.domRestricted).toBe(false);
    });

    it('parses 0 0 1,15 * * as the 1st and 15th at midnight with domRestricted', () => {
      const cron = parseCron('0 0 1,15 * *');
      expect([...cron.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
      expect(cron.domRestricted).toBe(true);
      expect(cron.dowRestricted).toBe(false);
    });

    it('parses 5-30/5 * * * * as a stepped range', () => {
      const cron = parseCron('5-30/5 * * * *');
      expect([...cron.minutes]).toEqual([5, 10, 15, 20, 25, 30]);
    });

    it('accepts 7 in day-of-week as Sunday (normalised to 0)', () => {
      expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
      expect([...parseCron('0 0 * * 5-7').daysOfWeek].sort()).toEqual([0, 5, 6]);
    });

    it('lets a step larger than the range match only the range start', () => {
      expect([...parseCron('*/100 * * * *').minutes]).toEqual([0]);
    });

    it('treats any non-* day field as restricted, including stepped stars and full ranges', () => {
      expect(parseCron('0 0 */2 * *').domRestricted).toBe(true);
      expect(parseCron('0 0 1-31 * *').domRestricted).toBe(true);
      expect(parseCron('0 0 * * */2').dowRestricted).toBe(true);
    });

    it('tolerates extra whitespace between fields and around the expression', () => {
      const cron = parseCron('  0  9 * *  1-5  ');
      expect([...cron.hours]).toEqual([9]);
      expect([...cron.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('invalid expressions — SCHEDULE_INVALID via isCogniPipeError', () => {
    it.each([
      ['empty string', ''],
      ['whitespace-only string', '   '],
      ['4 fields', '* * * *'],
      ['6 fields (seconds not supported)', '* * * * * *'],
      ['minute 60', '60 * * * *'],
      ['hour 24', '* 24 * * *'],
      ['day-of-month 0', '* * 0 * *'],
      ['day-of-month 32', '* * 32 * *'],
      ['month 13', '* * * 13 *'],
      ['month 0', '* * * 0 *'],
      ['day-of-week 8', '* * * * 8'],
      ['zero step', '*/0 * * * *'],
      ['descending range', '5-1 * * * *'],
      ['non-numeric minute', 'a * * * *'],
      ['day names', '0 9 * * MON'],
      ['named range', '0 9 * * MON-FRI'],
      ['month names', '0 0 1 JAN *'],
      ['@daily macro', '@daily'],
      ['N/S form', '1/5 * * * *'],
      ['non-numeric range bound', 'a-b * * * *'],
      ['range above the field maximum', '0-60 * * * *'],
      ['empty list item', '1,,2 * * * *'],
      ['trailing comma', '1, * * * *'],
      ['double step', '*/2/3 * * * *'],
      ['non-numeric step', '*/x * * * *'],
      ['signed number', '+5 * * * *'],
      ['number with trailing garbage', '12abc * * * *'],
      ['unsafe integer', `${'9'.repeat(30)} * * * *`],
      ['question mark', '* * * * ?'],
      ['L token', '0 0 L * *'],
      ['hash token', '0 0 * * 5#2'],
      ['300-character expression', '* '.repeat(150)],
    ] as const)('rejects %s', (_label, expression) => {
      expectCronError(() => parseCron(expression));
    });

    it('rejects non-string input from untrusted callers', () => {
      expectCronError(() => parseCron(undefined as unknown as string));
      expectCronError(() => parseCron(null as unknown as string));
      const err = expectCronError(() => parseCron(5 as unknown as string));
      expect(err.message).toContain('number');
    });

    it('names the offending field and value in the error message', () => {
      const err = expectCronError(() => parseCron('60 * * * *'));
      expect(err.message).toBe(
        'Cron field "minute" has value "60" which is outside 0-59. Expression: "60 * * * *"',
      );
      expect(err.context).toEqual({ field: 'minute', value: '60', expression: '60 * * * *' });
    });

    it('names the day-of-week field for a day name', () => {
      const err = expectCronError(() => parseCron('0 9 * * MON'));
      expect(err.message).toContain('"day-of-week"');
      expect(err.message).toContain('"MON"');
    });

    it('does not echo an over-long expression back in the error message', () => {
      const err = expectCronError(() => parseCron('x'.repeat(300)));
      expect(err.message).toContain('300 characters');
      expect(err.message.length).toBeLessThan(200);
    });
  });

  describe('adversarial input (ReDoS regression — mirrors interpolation.test.ts)', () => {
    it('rejects a 200,000-character comma flood in under 200 ms', () => {
      const adversarial = '*,'.repeat(100_000);
      const start = Date.now();
      expectCronError(() => parseCron(adversarial));
      expect(Date.now() - start).toBeLessThan(200);
    });

    it('rejects a 100,000-space string in under 200 ms', () => {
      const adversarial = ' '.repeat(100_000);
      const start = Date.now();
      expectCronError(() => parseCron(adversarial));
      expect(Date.now() - start).toBeLessThan(200);
    });

    it('rejects a 100,000-character digit run in under 200 ms', () => {
      const adversarial = '9'.repeat(100_000) + ' * * * *';
      const start = Date.now();
      expectCronError(() => parseCron(adversarial));
      expect(Date.now() - start).toBeLessThan(200);
    });
  });
});

describe('nextCronRun (UTC)', () => {
  it('returns the next minute strictly after `after`, even when `after` is exactly on a match', () => {
    const cron = parseCron('* * * * *');
    const next = nextCronRun(cron, new Date('2026-01-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('zeroes seconds and milliseconds', () => {
    const cron = parseCron('* * * * *');
    const next = nextCronRun(cron, new Date('2026-01-01T00:00:30.500Z'));
    expect(next?.toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(next?.getUTCSeconds()).toBe(0);
    expect(next?.getUTCMilliseconds()).toBe(0);
  });

  it('a time exactly on a match returns the NEXT match, not itself', () => {
    const cron = parseCron('*/15 * * * *');
    expect(nextCronRun(cron, new Date('2026-01-01T00:15:00Z'))?.toISOString()).toBe(
      '2026-01-01T00:30:00.000Z',
    );
    expect(nextCronRun(cron, new Date('2026-01-01T00:14:59.999Z'))?.toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    );
  });

  it('rolls over the hour boundary', () => {
    const cron = parseCron('0 * * * *');
    expect(nextCronRun(cron, new Date('2026-01-01T00:59:30Z'))?.toISOString()).toBe(
      '2026-01-01T01:00:00.000Z',
    );
  });

  it('rolls over the day boundary', () => {
    const cron = parseCron('0 0 * * *');
    expect(nextCronRun(cron, new Date('2026-01-01T23:59:00Z'))?.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('rolls over the month boundary', () => {
    const cron = parseCron('0 0 1 * *');
    expect(nextCronRun(cron, new Date('2026-01-31T23:59:00Z'))?.toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('rolls over the year boundary', () => {
    const cron = parseCron('0 0 1 1 *');
    expect(nextCronRun(cron, new Date('2026-12-31T23:59:00Z'))?.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('skips months that are not allowed', () => {
    const cron = parseCron('0 12 15 3,9 *');
    expect(nextCronRun(cron, new Date('2026-03-15T12:00:00Z'))?.toISOString()).toBe(
      '2026-09-15T12:00:00.000Z',
    );
  });

  it('finds a later hour on the same day and a later minute within the same hour', () => {
    const cron = parseCron('45 17 * * *');
    expect(nextCronRun(cron, new Date('2026-01-01T08:20:00Z'))?.toISOString()).toBe(
      '2026-01-01T17:45:00.000Z',
    );
    expect(nextCronRun(cron, new Date('2026-01-01T17:10:00Z'))?.toISOString()).toBe(
      '2026-01-01T17:45:00.000Z',
    );
  });

  it('handles 0 0 29 2 * across a non-leap year in well under 50 ms', () => {
    const cron = parseCron('0 0 29 2 *');
    const start = Date.now();
    const next = nextCronRun(cron, new Date('2026-03-01T00:00:00Z'));
    const elapsed = Date.now() - start;
    expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(elapsed).toBeLessThan(50);
  });

  it('resolves the longest possible gap (Feb 29 across 2100, a non-leap century) within the horizon', () => {
    const cron = parseCron('0 0 29 2 *');
    expect(nextCronRun(cron, new Date('2096-02-29T00:00:00Z'))?.toISOString()).toBe(
      '2104-02-29T00:00:00.000Z',
    );
  });

  it('returns undefined for 0 0 30 2 * (February never has 30 days)', () => {
    const cron = parseCron('0 0 30 2 *');
    expect(nextCronRun(cron, new Date('2026-01-01T00:00:00Z'))).toBeUndefined();
  });

  it('returns undefined instead of looping when `after` is an invalid Date', () => {
    expect(nextCronRun(parseCron('* * * * *'), new Date(Number.NaN))).toBeUndefined();
  });

  describe('day-of-month / day-of-week semantics', () => {
    it('matches EITHER field when both are restricted (13th OR Friday)', () => {
      const cron = parseCron('0 0 13 * 5');
      // 2026-01-01 is a Thursday, so the next Friday is Jan 2.
      expect(nextCronRun(cron, new Date('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
        '2026-01-02T00:00:00.000Z',
      );
      // After Fri Jan 9 the next Friday is Jan 16, but the 13th (a Tuesday) comes first.
      expect(nextCronRun(cron, new Date('2026-01-09T00:00:00Z'))?.toISOString()).toBe(
        '2026-01-13T00:00:00.000Z',
      );
    });

    it('applies only day-of-month when day-of-week is *', () => {
      const cron = parseCron('0 0 13 * *');
      expect(nextCronRun(cron, new Date('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
        '2026-01-13T00:00:00.000Z',
      );
    });

    it('applies only day-of-week when day-of-month is *', () => {
      const cron = parseCron('0 0 * * 1');
      // The next Monday after Thu Jan 1 2026 is Jan 5.
      expect(nextCronRun(cron, new Date('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
        '2026-01-05T00:00:00.000Z',
      );
    });

    it('matches every day when neither field is restricted', () => {
      const cron = parseCron('0 0 * * *');
      expect(nextCronRun(cron, new Date('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
        '2026-01-02T00:00:00.000Z',
      );
    });

    it('treats 7 as Sunday when computing run times', () => {
      const cron = parseCron('0 0 * * 7');
      // Jan 4 2026 is the first Sunday of the year.
      expect(nextCronRun(cron, new Date('2026-01-01T00:00:00Z'))?.toISOString()).toBe(
        '2026-01-04T00:00:00.000Z',
      );
    });
  });
});

describe('nextCronRun — local timezone', () => {
  // These tests are written to hold in ANY host time zone. Setting process.env.TZ
  // from inside a Jest test file does not work: Jest gives each test file a COPY
  // of process.env, so the real process never sees the change. To exercise the
  // suite under a specific zone, pin it from the shell instead:
  //   TZ=America/New_York pnpm --filter @cognipipe/core test -- cron
  // Expected values are therefore built with the local-time Date constructor
  // rather than hard-coded UTC instants.
  const hostOffsetMinutes = new Date(2026, 0, 1).getTimezoneOffset();
  const nonUtcIt = hostOffsetMinutes === 0 ? it.skip : it;

  it('fires at the LOCAL hour, not the UTC hour', () => {
    const cron = parseCron('0 9 * * *');
    const after = new Date(2026, 0, 1, 7, 0, 0, 0);
    const next = nextCronRun(cron, after, 'local');
    expect(next?.getTime()).toBe(new Date(2026, 0, 1, 9, 0, 0, 0).getTime());
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
  });

  it('rolls over to the next LOCAL day', () => {
    const cron = parseCron('30 23 * * *');
    const after = new Date(2026, 0, 1, 23, 45, 0, 0);
    expect(nextCronRun(cron, after, 'local')?.getTime()).toBe(
      new Date(2026, 0, 2, 23, 30, 0, 0).getTime(),
    );
  });

  it('applies day-of-week against the LOCAL calendar', () => {
    const cron = parseCron('0 0 * * 1');
    // Local Thu Jan 1 2026 → local Monday Jan 5 at 00:00.
    expect(nextCronRun(cron, new Date(2026, 0, 1, 12, 0), 'local')?.getTime()).toBe(
      new Date(2026, 0, 5, 0, 0, 0, 0).getTime(),
    );
  });

  nonUtcIt('differs from UTC mode when the host zone is not UTC', () => {
    const cron = parseCron('0 9 * * *');
    const after = new Date(2026, 0, 1, 7, 0, 0, 0);
    const local = nextCronRun(cron, after, 'local');
    const utc = nextCronRun(cron, after, 'utc');
    expect(local?.getTime()).not.toBe(utc?.getTime());
  });

  it('keeps UTC mode independent of the host zone', () => {
    const cron = parseCron('0 9 * * *');
    expect(nextCronRun(cron, new Date('2026-01-01T12:00:00Z'))?.toISOString()).toBe(
      '2026-01-02T09:00:00.000Z',
    );
  });

  it('never returns an instant that is not strictly after `after` (fall-back guard, any host zone)', () => {
    // During a DST fall-back the repeated wall-clock hour exists twice. Local
    // time resolves a wall time to its FIRST instant, so when `after` already
    // sits in the SECOND pass, the resolved instant is not after `after`, and
    // returning it would make a scheduler re-fire the same tick forever.
    // The real overlap only exists in zones with DST, so it is modelled here
    // by reporting an `after` instant three minutes later than its wall-clock
    // fields suggest. That makes this test run, and cover the guard, in every
    // host zone (including UTC on CI).
    const MINUTE_MS = 60_000;
    const after = new Date(2026, 0, 1, 9, 0, 0, 0);
    const realAfter = after.getTime();
    jest.spyOn(after, 'getTime').mockReturnValue(realAfter + 3 * MINUTE_MS);

    const next = nextCronRun(parseCron('* * * * *'), after, 'local');

    // 09:01, 09:02 and 09:03 resolve to instants that are not after `after`
    // and are skipped; 09:04 is the first one that is.
    expect(next?.getTime()).toBe(realAfter + 4 * MINUTE_MS);
  });

  describe('DST transitions (run only when the host zone observes DST)', () => {
    const MINUTE_MS = 60_000;
    const HOUR_MS = 3_600_000;

    interface DstTransitions {
      springForward: Date;
      fallBack: Date;
    }

    /** Finds the first spring-forward and fall-back instants of `year` in the host zone. */
    function findDstTransitions(year: number): DstTransitions | undefined {
      let springForward: Date | undefined;
      let fallBack: Date | undefined;
      const start = new Date(year, 0, 1, 0, 0).getTime();
      let previousOffset = new Date(start).getTimezoneOffset();
      for (let hour = 1; hour <= 366 * 24; hour++) {
        const instant = new Date(start + hour * HOUR_MS);
        const offset = instant.getTimezoneOffset();
        if (offset < previousOffset) {
          springForward ??= instant;
        } else if (offset > previousOffset) {
          fallBack ??= instant;
        }
        previousOffset = offset;
      }
      return springForward !== undefined && fallBack !== undefined
        ? { springForward, fallBack }
        : undefined;
    }

    const transitions = findDstTransitions(2026);
    const dstIt = transitions === undefined ? it.skip : it;

    /** Returns the transitions; only called from tests that dstIt has not skipped. */
    function requireTransitions(): DstTransitions {
      if (transitions === undefined) {
        throw new Error('The host time zone does not observe DST.');
      }
      return transitions;
    }

    /** Size of the clock change at a transition, measured from the host zone's own offsets. */
    function shiftMs(sample: Date): number {
      const before = new Date(sample.getTime() - HOUR_MS).getTimezoneOffset();
      return Math.abs(sample.getTimezoneOffset() - before) * MINUTE_MS;
    }

    /** Walks back from an hourly sample to the first minute at which the new offset applies. */
    function exactTransition(sample: Date): Date {
      const newOffset = sample.getTimezoneOffset();
      let t = sample.getTime();
      while (new Date(t - MINUTE_MS).getTimezoneOffset() === newOffset) {
        t -= MINUTE_MS;
      }
      return new Date(t);
    }

    /**
     * Asks for the next run from EVERY minute in a window around `center` and
     * checks that each answer is strictly later than the instant it was asked
     * from, and no further away than `maxGapMs`.
     *
     * This is the regression guard for a scheduler re-firing the same tick
     * forever. It only bites when `after` lies inside the repeated hour of a
     * fall-back: there a wall time resolves to its FIRST instant, which is
     * earlier than `after`, so an unguarded search would hand back a time in
     * the past and the scheduler would keep arming it.
     */
    function expectEveryNextRunIsStrictlyLater(
      expression: string,
      center: Date,
      maxGapMs: number,
    ): void {
      const parsed = parseCron(expression);
      for (let minute = -90; minute <= 150; minute++) {
        const after = new Date(center.getTime() + minute * MINUTE_MS);
        const next = nextCronRun(parsed, after, 'local');
        if (next === undefined) {
          throw new Error(`No next run after ${after.toISOString()}`);
        }
        expect(next.getTime()).toBeGreaterThan(after.getTime());
        expect(next.getTime() - after.getTime()).toBeLessThanOrEqual(maxGapMs);
      }
    }

    dstIt('an every-minute schedule always moves forward around the spring-forward gap', () => {
      expectEveryNextRunIsStrictlyLater(
        '* * * * *',
        requireTransitions().springForward,
        2 * HOUR_MS,
      );
    });

    dstIt('an every-minute schedule always moves forward around the fall-back overlap', () => {
      const { fallBack } = requireTransitions();
      // Longest gap: the whole repeated period plus the one minute to the next wall minute.
      expectEveryNextRunIsStrictlyLater('* * * * *', fallBack, shiftMs(fallBack) + MINUTE_MS);
    });

    dstIt(
      'fires the first wall minute inside the spring-forward gap at the transition instant',
      () => {
        const { springForward } = requireTransitions();
        const transition = exactTransition(springForward);
        const lastBefore = new Date(transition.getTime() - MINUTE_MS);
        const skippedWallMinutes = lastBefore.getHours() * 60 + lastBefore.getMinutes() + 1;
        const hour = Math.floor(skippedWallMinutes / 60) % 24;
        const minute = skippedWallMinutes % 60;
        const parsed = parseCron(`${minute} ${hour} * * *`);

        // That wall time does not exist today: it resolves with the pre-transition offset.
        const onGapDay = nextCronRun(
          parsed,
          new Date(transition.getTime() - 10 * MINUTE_MS),
          'local',
        );
        expect(onGapDay?.getTime()).toBe(transition.getTime());

        // Control: on an ordinary day the same expression fires at exactly that local time.
        const ordinary = nextCronRun(
          parsed,
          new Date(transition.getTime() - 3 * 24 * HOUR_MS),
          'local',
        );
        expect(ordinary?.getHours()).toBe(hour);
        expect(ordinary?.getMinutes()).toBe(minute);
      },
    );

    dstIt('finds a shifted gap occurrence after the clocks have jumped', () => {
      const { springForward } = requireTransitions();
      const transition = exactTransition(springForward);
      const elapsed = 10 * MINUTE_MS;
      const before = new Date(transition.getTime() - MINUTE_MS);
      const gapMinute = (before.getHours() * 60 + before.getMinutes() + 11) % (24 * 60);
      const cron = parseCron(`${gapMinute % 60} ${Math.floor(gapMinute / 60)} * * *`);

      const shifted = new Date(transition.getTime() + elapsed);
      const after = new Date(transition.getTime() + MINUTE_MS);
      expect(nextCronRun(cron, after, 'local')).toEqual(shifted);
    });

    const lordHoweIt =
      Intl.DateTimeFormat().resolvedOptions().timeZone === 'Australia/Lord_Howe' ? it : it.skip;
    lordHoweIt('orders shifted and ordinary matches by instant across a half-hour gap', () => {
      const cron = parseCron('15,30,45 2 * * *');
      const before = new Date('2026-10-03T15:29:00Z');
      const first = new Date('2026-10-03T15:30:00Z'); // 02:30 local.
      const second = new Date('2026-10-03T15:45:00Z'); // 02:15 shifted and 02:45 local.
      const nextDay = new Date('2026-10-04T15:15:00Z'); // 02:15 local.

      expect(nextCronRun(cron, before, 'local')).toEqual(first);
      expect(nextCronRun(cron, first, 'local')).toEqual(second);
      expect(nextCronRun(cron, second, 'local')).toEqual(nextDay);
    });

    dstIt(
      'a daily schedule is never answered with a past instant inside the fall-back hour',
      () => {
        // "30 1 * * *" resolves to the first of two 01:30 instants on fall-back day.
        expectEveryNextRunIsStrictlyLater(
          '30 1 * * *',
          requireTransitions().fallBack,
          26 * HOUR_MS,
        );
      },
    );

    dstIt('a daily schedule fires once per local day, never twice, around both transitions', () => {
      const parsed = parseCron('30 1 * * *');
      const { springForward, fallBack } = requireTransitions();
      for (const transition of [springForward, fallBack]) {
        const runs: Date[] = [];
        let cursor = new Date(transition.getTime() - 3 * 24 * HOUR_MS);
        for (let i = 0; i < 6; i++) {
          const next = nextCronRun(parsed, cursor, 'local');
          if (next === undefined) {
            throw new Error(`No next run after ${cursor.toISOString()}`);
          }
          runs.push(next);
          cursor = next;
        }
        const gapsInHours = runs
          .slice(1)
          .map((run, index) => (run.getTime() - (runs[index]?.getTime() ?? Number.NaN)) / HOUR_MS);
        expect(gapsInHours).toHaveLength(5);
        for (const gap of gapsInHours) {
          expect(gap).toBeGreaterThanOrEqual(22);
          expect(gap).toBeLessThanOrEqual(26);
        }
      }
    });
  });
});
