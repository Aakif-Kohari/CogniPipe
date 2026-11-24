/**
 * @module WorkflowScheduler
 *
 * Engine-level building block for scheduled workflow execution (Roadmap
 * Phase 3). Arms one timer per job from a standard 5-field cron expression
 * and runs a validated WorkflowConfig through a given WorkflowExecutor.
 *
 * Design guarantees:
 * - The next fire time is computed from the SCHEDULED minute, so timer jitter
 *   never double-fires or skips a minute.
 * - No backfill: after a process suspension, at most one run happens for the
 *   whole missed gap, then the schedule continues from the next future tick.
 * - Fire times beyond setTimeout's 2^31-1 ms cap are re-armed in chunks without
 *   running the workflow; a timer that fires early re-arms instead of running.
 * - A failed run never becomes an unhandled rejection and never stops the job.
 *
 * Out of scope (separate follow-ups): a YAML `schedule:` key, a CLI command,
 * persistence, backfilling missed runs and IANA time zones.
 */

import type { WorkflowConfig } from '@cognipipe/types';
import type { ExecutionResult, WorkflowExecutor } from './WorkflowExecutor.js';
import { nextCronRun, parseCron } from './cron.js';
import type { ParsedCron, SchedulerTimezone } from './cron.js';
import { CogniPipeError } from '../errors/CogniPipeError.js';
import { COGNIPIPE_ERROR_CODES } from '../errors/errorCodes.js';

/**
 * Identifies one scheduled tick. Passed to `onComplete` and `onError`.
 *
 * @example
 * ```typescript
 * const onComplete = (result: ExecutionResult, info: ScheduledRunInfo) => {
 *   audit.record(info.jobId, info.scheduledFor);
 * };
 * ```
 */
export interface ScheduledRunInfo {
  /** The job's id (explicit or auto-generated). */
  jobId: string;
  /** The exact minute this run was scheduled for — not when it actually started. */
  scheduledFor: Date;
}

/**
 * Per-job options for {@link WorkflowScheduler.schedule}.
 *
 * @example
 * ```typescript
 * scheduler.schedule(config, '0 9 * * 1-5', {
 *   id: 'weekday-report',
 *   overlap: 'skip',
 *   initial: { team: 'core' },
 *   onError: (error, info) => alerts.notify(info.jobId, error),
 * });
 * ```
 */
export interface ScheduleOptions {
  /** Unique job id. Default: auto-generated ("job-1", "job-2", …). Duplicate id → SCHEDULE_INVALID. */
  id?: string;
  /** Clock the cron fields are matched against. Default `'utc'`. */
  timezone?: SchedulerTimezone;
  /**
   * `'skip'` (default): if the previous run is still in progress at a tick,
   * that tick is skipped. `'allow'`: runs may overlap concurrently.
   */
  overlap?: 'skip' | 'allow';
  /**
   * Extra seed data merged into the run's `initial` context. Shallow-copied when
   * `schedule()` is called, so later changes to the object's top-level keys do not
   * affect the job (nested values are shared by reference). The `trigger` key is
   * reserved — it is always set last and cannot be overridden.
   */
  initial?: Record<string, unknown>;
  /**
   * Called with the ExecutionResult after each run that completes. May be async: a
   * rejected promise is reported like a throw and never becomes an unhandled rejection.
   */
  onComplete?: (result: ExecutionResult, info: ScheduledRunInfo) => void | Promise<void>;
  /**
   * Called when a run rejects. May be async. If omitted, failures are reported via
   * `process.emitWarning` — never thrown, never an unhandled rejection.
   */
  onError?: (error: unknown, info: ScheduledRunInfo) => void | Promise<void>;
}

/**
 * A live handle to one scheduled job, returned by {@link WorkflowScheduler.schedule}.
 *
 * @example
 * ```typescript
 * const job = scheduler.schedule(config, '0 0 * * *');
 * job.nextRunAt(); // the next midnight UTC
 * job.stop(); // clears the timer; an in-flight run is allowed to finish
 * ```
 */
export interface ScheduledJob {
  /** The job's unique id. */
  readonly id: string;
  /** The cron expression this job was scheduled with, verbatim. */
  readonly cron: string;
  /** The next scheduled fire time, or `undefined` after `stop()`. */
  nextRunAt(): Date | undefined;
  /** True while a run of this job is in flight right now. */
  isRunning(): boolean;
  /** Clears the timer and removes the job from the scheduler. Idempotent; in-flight runs finish. */
  stop(): void;
}

/** setTimeout's maximum delay (2^31 - 1 ms, about 24.8 days). Farther targets are chunked. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Internal mutable state for one armed job. Never exposed to callers. */
interface JobState {
  readonly id: string;
  readonly cron: string;
  readonly parsed: ParsedCron;
  readonly timezone: SchedulerTimezone;
  readonly overlap: 'skip' | 'allow';
  readonly config: WorkflowConfig;
  /** Shallow snapshot of `options.initial`, taken once when schedule() is called. */
  readonly initial: Readonly<Record<string, unknown>> | undefined;
  readonly onComplete: ScheduleOptions['onComplete'];
  readonly onError: ScheduleOptions['onError'];
  readonly handle: ScheduledJob;
  /** Epoch ms of the next fire, or undefined once stopped. A number, so no mutable Date is shared. */
  nextAtMs: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Number of runs of this job currently in flight. */
  running: number;
  stopped: boolean;
}

/**
 * Runs validated workflows on cron schedules through a {@link WorkflowExecutor}.
 * The executor is stateless per call, so one scheduler may drive many jobs (and
 * overlapping runs) through the same executor instance.
 *
 * Each run receives a shallow snapshot of `options.initial` taken when
 * `schedule()` is called, merged with `{ trigger: { type: 'schedule', cron,
 * scheduledAt } }`, as its initial context, so steps can reference
 * `{{ trigger.scheduledAt }}`. Armed timers keep the Node.js event loop alive;
 * call {@link WorkflowScheduler.stopAll} on shutdown.
 *
 * @example
 * ```typescript
 * const scheduler = new WorkflowScheduler(executor);
 * scheduler.schedule(config, '0 9 * * 1-5', {
 *   id: 'weekday-report',
 *   onComplete: (result, info) => audit.record(info.jobId, info.scheduledFor),
 * });
 * // later, on shutdown:
 * scheduler.stopAll();
 * ```
 */
export class WorkflowScheduler {
  readonly #executor: WorkflowExecutor;
  readonly #jobs: Map<string, JobState> = new Map();
  #autoId = 1;

  /**
   * @param executor - The WorkflowExecutor every scheduled run is dispatched
   *   through. Its registry must contain every node the scheduled workflows use.
   */
  constructor(executor: WorkflowExecutor) {
    this.#executor = executor;
  }

  /**
   * Validates the cron expression, arms a timer and returns the job handle.
   * Does NOT run the workflow immediately — the first run happens at the first
   * matching minute strictly after "now".
   *
   * @param config - A fully validated WorkflowConfig (output of WorkflowValidator.validate()).
   * @param cron - A standard 5-field cron expression, e.g. `"0 9 * * 1-5"`.
   * @param options - Per-job options (id, timezone, overlap, initial, callbacks).
   * @returns A live handle for inspecting and stopping the job.
   * @throws {CogniPipeError} SCHEDULE_INVALID if the expression is malformed, the
   *   id is already in use, an unsupported `timezone` or `overlap` value is passed,
   *   or the schedule can never fire. Nothing is armed when this throws.
   *
   * @example
   * ```typescript
   * const job = scheduler.schedule(config, '0 0 * * *', { id: 'nightly' });
   * job.nextRunAt(); // the next midnight UTC
   * ```
   */
  schedule(config: WorkflowConfig, cron: string, options: ScheduleOptions = {}): ScheduledJob {
    // Read every option exactly once, up front. The job keeps these captured values, so later
    // changes to the caller's options object (or a getter on it) can never alter a live job.
    const {
      id: explicitId,
      timezone = 'utc',
      overlap = 'skip',
      initial,
      onComplete,
      onError,
    } = options;
    const initialSnapshot = initial === undefined ? undefined : { ...initial };

    // Throws SCHEDULE_INVALID for a malformed expression before anything else.
    const parsed = parseCron(cron);

    // Untyped callers (plain JS, a future YAML key) can pass any string. Anything other than
    // the exact literals would silently mean host-local time / overlapping runs.
    if (timezone !== 'utc' && timezone !== 'local') {
      throw new CogniPipeError(
        `Unsupported timezone "${String(timezone)}". Use 'utc' or 'local' — IANA time zones are not supported.`,
        { code: COGNIPIPE_ERROR_CODES.SCHEDULE_INVALID, context: { timezone } },
      );
    }
    if (overlap !== 'skip' && overlap !== 'allow') {
      throw new CogniPipeError(
        `Unsupported overlap policy "${String(overlap)}". Use 'skip' or 'allow'.`,
        { code: COGNIPIPE_ERROR_CODES.SCHEDULE_INVALID, context: { overlap } },
      );
    }

    if (explicitId !== undefined && this.#jobs.has(explicitId)) {
      throw new CogniPipeError(
        `A scheduled job with id "${explicitId}" already exists. Job ids must be unique — pass a different options.id or omit it to auto-generate one.`,
        { code: COGNIPIPE_ERROR_CODES.SCHEDULE_INVALID, context: { jobId: explicitId } },
      );
    }

    const first = nextCronRun(parsed, new Date(), timezone);
    if (first === undefined) {
      throw new CogniPipeError(
        `Cron expression "${cron}" is valid but this schedule can never fire (for example "0 0 30 2 *" — February never has 30 days). Nothing was scheduled.`,
        { code: COGNIPIPE_ERROR_CODES.SCHEDULE_INVALID, context: { cron } },
      );
    }

    // Consume an auto id only once every validation above has passed, so a
    // rejected schedule() call never burns a "job-N" number.
    const id = explicitId ?? this.#nextAutoId();

    // The handle's methods close over `state`, which is assigned below before
    // the handle is ever returned to a caller.
    const handle: ScheduledJob = Object.freeze({
      id,
      cron,
      // A fresh Date every call: the armed target is never exposed, so a caller
      // mutating the result cannot move the job.
      nextRunAt: (): Date | undefined =>
        state.stopped || state.nextAtMs === undefined ? undefined : new Date(state.nextAtMs),
      isRunning: (): boolean => state.running > 0,
      stop: (): void => this.#stop(state),
    });

    const state: JobState = {
      id,
      cron,
      parsed,
      timezone,
      overlap,
      config,
      initial: initialSnapshot,
      onComplete,
      onError,
      handle,
      nextAtMs: first.getTime(),
      timer: undefined,
      running: 0,
      stopped: false,
    };

    this.#jobs.set(id, state);
    this.#arm(state, first.getTime());
    return handle;
  }

  /**
   * Returns a frozen snapshot of the currently scheduled (active) jobs. Stopped
   * jobs are removed from the list; handles you already hold keep working
   * (their `nextRunAt()` returns `undefined`).
   *
   * @example
   * ```typescript
   * scheduler.listJobs().map(job => job.id); // ['nightly', 'job-1']
   * ```
   */
  listJobs(): readonly ScheduledJob[] {
    return Object.freeze([...this.#jobs.values()].map(state => state.handle));
  }

  /**
   * Stops every scheduled job. In-flight runs are allowed to finish and still
   * invoke their callbacks.
   *
   * @example
   * ```typescript
   * process.on('SIGTERM', () => {
   *   scheduler.stopAll();
   * });
   * ```
   */
  stopAll(): void {
    for (const state of [...this.#jobs.values()]) {
      this.#stop(state);
    }
  }

  /** Generates "job-N", skipping any N already claimed by an explicit id. */
  #nextAutoId(): string {
    while (this.#jobs.has(`job-${this.#autoId}`)) {
      this.#autoId += 1;
    }
    const id = `job-${this.#autoId}`;
    this.#autoId += 1;
    return id;
  }

  /**
   * Arms the timer toward `targetMs`. Delays beyond setTimeout's 2^31-1 ms cap
   * are clamped, so the timer fires as a "chunk" and #onTimer re-arms without
   * running — this is what makes far-future fire times safe.
   */
  #arm(state: JobState, targetMs: number): void {
    const delay = Math.min(Math.max(targetMs - Date.now(), 0), MAX_TIMER_DELAY_MS);
    state.timer = setTimeout(() => this.#onTimer(state, targetMs), delay);
  }

  /**
   * Timer callback: guards against early fires, advances the schedule, then launches a run.
   * Runs no user code, so nothing here can throw on the timer path.
   */
  #onTimer(state: JobState, scheduledMs: number): void {
    const now = Date.now();
    if (now < scheduledMs) {
      // Either a >24.8-day chunk elapsed or the timer fired early — re-arm, never run.
      this.#arm(state, scheduledMs);
      return;
    }

    // Compute the next tick from the SCHEDULED minute so on-time jitter can never
    // double-fire or skip a minute. After a suspension `now` is later and wins:
    // missed ticks are skipped (no backfill) and at most one run happens for the gap.
    const next = nextCronRun(state.parsed, new Date(Math.max(now, scheduledMs)), state.timezone);
    if (next === undefined) {
      // No further fire time exists; this run is the job's last.
      this.#stop(state);
    } else {
      const nextMs = next.getTime();
      state.nextAtMs = nextMs;
      this.#arm(state, nextMs);
    }

    if (state.overlap === 'skip' && state.running > 0) {
      // The previous run is still in flight — skip this tick, keep the schedule.
      return;
    }
    this.#launch(state, scheduledMs);
  }

  /** Builds the info object handed to a callback: always a fresh copy, never scheduler state. */
  #info(state: JobState, scheduledMs: number): ScheduledRunInfo {
    return { jobId: state.id, scheduledFor: new Date(scheduledMs) };
  }

  /** Dispatches one run. Every outcome is handled — nothing can reject unobserved. */
  #launch(state: JobState, scheduledMs: number): void {
    // `trigger` is spread LAST so a caller cannot override it through the initial data.
    const initial: Record<string, unknown> = {
      ...state.initial,
      trigger: {
        type: 'schedule',
        cron: state.cron,
        scheduledAt: new Date(scheduledMs).toISOString(),
      },
    };

    state.running += 1;
    // executor.run() is async, so even a synchronous failure inside it arrives as
    // a rejection and is handled below — never an unhandled rejection.
    void this.#executor.run(state.config, initial).then(
      result => {
        state.running -= 1;
        this.#notify(state, scheduledMs, () =>
          state.onComplete?.(result, this.#info(state, scheduledMs)),
        );
      },
      (error: unknown) => {
        state.running -= 1;
        const onError = state.onError;
        if (onError === undefined) {
          this.#warn(state, scheduledMs, error);
        } else {
          this.#notify(state, scheduledMs, () => onError(error, this.#info(state, scheduledMs)));
        }
      },
    );
  }

  /**
   * Invokes a user callback. A synchronous throw AND a rejected promise returned by an
   * async callback are both reported, so neither can crash the process.
   */
  #notify(state: JobState, scheduledMs: number, callback: () => void | Promise<void>): void {
    try {
      void Promise.resolve(callback()).catch((error: unknown) =>
        this.#warn(state, scheduledMs, error),
      );
    } catch (error) {
      this.#warn(state, scheduledMs, error);
    }
  }

  /**
   * Default failure reporting: a process warning — never a throw, never console output.
   * This is the last-resort reporter, so it must itself be unable to throw: it uses the
   * private epoch ms (not a Date a callback could have corrupted) and a guarded message.
   */
  #warn(state: JobState, scheduledMs: number, error: unknown): void {
    let message: string;
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      message = 'an error whose message could not be read';
    }
    process.emitWarning(
      `Scheduled job "${state.id}" (cron "${state.cron}") failed for the run scheduled at ${new Date(scheduledMs).toISOString()}: ${message}`,
      'CogniPipeSchedulerWarning',
    );
  }

  /** Clears the timer and removes the job. In-flight runs are left to finish. */
  #stop(state: JobState): void {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.nextAtMs = undefined;
    this.#jobs.delete(state.id);
  }
}
