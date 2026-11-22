import type {
  IBaseNode,
  IExecutionContext,
  NodeConfig,
  NodeOutput,
  WorkflowConfig,
} from '@cognipipe/types';
import * as cron from '../../engine/cron';
import { WorkflowScheduler } from '../../engine/WorkflowScheduler';
import { WorkflowExecutor } from '../../engine/WorkflowExecutor';
import type { ExecutionResult } from '../../engine/WorkflowExecutor';
import { NodeRegistry } from '../../engine/NodeRegistry';
import { CogniPipeError, isCogniPipeError } from '../../errors/CogniPipeError';
import { COGNIPIPE_ERROR_CODES } from '../../errors/errorCodes';

// ---- Inline test doubles — do not import from @cognipipe/sdk ----

class EchoNode implements IBaseNode {
  async execute(config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    return { echoed: config };
  }
}

class FailNode implements IBaseNode {
  async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
    throw new Error('node failed');
  }
}

/**
 * Builds a node whose execute() blocks until `release()` is called, to model a
 * long-running workflow. `started()` counts how many executions have begun.
 */
function createGatedNode(): {
  GatedNode: new () => IBaseNode;
  started: () => number;
  release: () => void;
} {
  const resolvers: Array<() => void> = [];
  let startedCount = 0;

  class GatedNode implements IBaseNode {
    async execute(_config: NodeConfig, _ctx: IExecutionContext): Promise<NodeOutput> {
      startedCount += 1;
      await new Promise<void>(resolve => resolvers.push(resolve));
      return { ok: true };
    }
  }

  return {
    GatedNode,
    started: () => startedCount,
    release: () => resolvers.splice(0).forEach(resolve => resolve()),
  };
}

/** Builds a minimal valid WorkflowConfig with the given steps. */
function buildWorkflow(steps: WorkflowConfig['steps']): WorkflowConfig {
  return { name: 'scheduled-workflow', version: '1.0.0', steps };
}

/** Asserts fn() throws a CogniPipeError with SCHEDULE_INVALID and returns it. */
function expectScheduleError(fn: () => unknown): CogniPipeError {
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

/**
 * Makes Date.now() run `offsetMs` ahead of (or, if negative, behind) the fake
 * clock. Jest's setSystemTime() cannot model a suspended process because it
 * shifts every pending timer along with the clock; skewing Date.now() alone
 * leaves the timers where they are, exactly like a clock that jumped while the
 * process was frozen.
 */
function skewClock(offsetMs: number): void {
  const fakeNow = Date.now;
  jest.spyOn(Date, 'now').mockImplementation(() => fakeNow() + offsetMs);
}

const TICK_1 = '2026-01-01T00:01:00.000Z';
const MINUTE_MS = 60_000;
// setTimeout's documented maximum delay (2^31 - 1 ms).
const MAX_TIMER_DELAY_MS = 2_147_483_647;

describe('WorkflowScheduler', () => {
  let registry: NodeRegistry;
  let executor: WorkflowExecutor;
  let scheduler: WorkflowScheduler;
  let config: WorkflowConfig;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    registry = new NodeRegistry();
    registry.register('@cognipipe/node-echo', EchoNode);
    registry.register('@cognipipe/node-fail', FailNode);
    executor = new WorkflowExecutor(registry);
    scheduler = new WorkflowScheduler(executor);
    config = buildWorkflow([{ name: 'step-a', uses: '@cognipipe/node-echo', config: {} }]);
  });

  afterEach(() => {
    scheduler.stopAll();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('schedule() validation — nothing is armed on failure', () => {
    it('throws SCHEDULE_INVALID synchronously for an invalid cron expression', () => {
      const err = expectScheduleError(() => scheduler.schedule(config, '60 * * * *'));
      expect(err.message).toContain('"minute"');
      expect(scheduler.listJobs()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('throws SCHEDULE_INVALID for a duplicate id and arms nothing extra', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      scheduler.schedule(config, '* * * * *', { id: 'dup' });

      const err = expectScheduleError(() => scheduler.schedule(config, '* * * * *', { id: 'dup' }));

      expect(err.message).toContain('"dup"');
      expect(scheduler.listJobs()).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('throws SCHEDULE_INVALID for a never-firing schedule and arms nothing', async () => {
      const runSpy = jest.spyOn(executor, 'run');

      const err = expectScheduleError(() => scheduler.schedule(config, '0 0 30 2 *'));

      expect(err.message).toContain('never fire');
      expect(scheduler.listJobs()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);

      await jest.advanceTimersByTimeAsync(10 * MINUTE_MS);
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('does not consume an auto-generated id when scheduling is rejected', () => {
      expectScheduleError(() => scheduler.schedule(config, '0 0 30 2 *'));
      expectScheduleError(() => scheduler.schedule(config, '60 * * * *'));

      expect(scheduler.schedule(config, '* * * * *').id).toBe('job-1');
    });
  });

  describe('run semantics', () => {
    it('does NOT run immediately on schedule()', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      scheduler.schedule(config, '* * * * *');

      expect(runSpy).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(MINUTE_MS - 1);
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('runs once per advanced minute with the reserved trigger context', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      scheduler.schedule(config, '* * * * *');

      for (let minute = 1; minute <= 5; minute++) {
        await jest.advanceTimersByTimeAsync(MINUTE_MS);
        expect(runSpy).toHaveBeenCalledTimes(minute);
      }

      expect(runSpy).toHaveBeenNthCalledWith(1, config, {
        trigger: { type: 'schedule', cron: '* * * * *', scheduledAt: TICK_1 },
      });
      expect(runSpy).toHaveBeenNthCalledWith(5, config, {
        trigger: { type: 'schedule', cron: '* * * * *', scheduledAt: '2026-01-01T00:05:00.000Z' },
      });
    });

    it('merges custom initial data and never lets the caller override trigger', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      const onComplete = jest.fn();
      scheduler.schedule(config, '* * * * *', {
        initial: { team: 'core', trigger: { type: 'manual', cron: 'hacked' } },
        onComplete,
      });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(runSpy).toHaveBeenCalledWith(config, {
        team: 'core',
        trigger: { type: 'schedule', cron: '* * * * *', scheduledAt: TICK_1 },
      });
      const result = onComplete.mock.calls[0]?.[0] as ExecutionResult;
      expect(result.context.get('team')).toBe('core');
      expect(result.context.get('trigger')).toEqual({
        type: 'schedule',
        cron: '* * * * *',
        scheduledAt: TICK_1,
      });
    });

    it('lets steps interpolate {{ trigger.scheduledAt }}', async () => {
      const stamped = buildWorkflow([
        {
          name: 'stamp',
          uses: '@cognipipe/node-echo',
          config: { at: '{{ trigger.scheduledAt }}' },
        },
      ]);
      const onComplete = jest.fn();
      scheduler.schedule(stamped, '* * * * *', { onComplete });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      const result = onComplete.mock.calls[0]?.[0] as ExecutionResult;
      const steps = result.context.get('steps') as Record<
        string,
        { output: { echoed: { at: string } } }
      >;
      expect(steps['stamp']?.output.echoed.at).toBe(TICK_1);
    });

    it('onComplete receives the ExecutionResult and the ScheduledRunInfo', async () => {
      const onComplete = jest.fn();
      scheduler.schedule(config, '* * * * *', { id: 'report', onComplete });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ stepErrors: [] }), {
        jobId: 'report',
        scheduledFor: new Date(TICK_1),
      });
    });

    it('computes fire times from the schedule in the requested timezone', () => {
      const job = scheduler.schedule(config, '0 9 * * *', { timezone: 'local' });

      // Holds in any host zone: a local-time schedule always lands on local 09:00.
      expect(job.nextRunAt()?.getHours()).toBe(9);
      expect(job.nextRunAt()?.getMinutes()).toBe(0);
    });
  });

  describe('job handles and lifecycle', () => {
    it('auto-generates ids job-1, job-2, … and skips ids claimed explicitly', () => {
      const first = scheduler.schedule(config, '* * * * *');
      const second = scheduler.schedule(config, '* * * * *');
      expect(first.id).toBe('job-1');
      expect(second.id).toBe('job-2');
      expect(first.cron).toBe('* * * * *');

      const other = new WorkflowScheduler(executor);
      const explicit = other.schedule(config, '* * * * *', { id: 'job-1' });
      const auto = other.schedule(config, '* * * * *');
      expect(explicit.id).toBe('job-1');
      expect(auto.id).toBe('job-2');
      other.stopAll();
    });

    it('nextRunAt() reports the next scheduled minute and advances with the schedule', async () => {
      const job = scheduler.schedule(config, '* * * * *');
      expect(job.nextRunAt()?.toISOString()).toBe(TICK_1);

      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(job.nextRunAt()?.toISOString()).toBe('2026-01-01T00:02:00.000Z');
    });

    it('stop() makes nextRunAt() undefined, prevents further runs and is idempotent', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      const job = scheduler.schedule(config, '* * * * *');
      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(runSpy).toHaveBeenCalledTimes(1);

      job.stop();
      job.stop();

      expect(job.nextRunAt()).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5 * MINUTE_MS);
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('listJobs() reflects active jobs, is frozen, and drops stopped jobs', () => {
      expect(scheduler.listJobs()).toHaveLength(0);
      const a = scheduler.schedule(config, '* * * * *');
      const b = scheduler.schedule(config, '* * * * *');

      const listed = scheduler.listJobs();
      expect(Object.isFrozen(listed)).toBe(true);
      expect(listed.map(job => job.id)).toEqual([a.id, b.id]);

      a.stop();
      expect(scheduler.listJobs().map(job => job.id)).toEqual([b.id]);
    });

    it('frees a stopped job id for reuse', () => {
      const job = scheduler.schedule(config, '* * * * *', { id: 'reusable' });
      job.stop();

      expect(scheduler.schedule(config, '* * * * *', { id: 'reusable' }).id).toBe('reusable');
    });

    it('stopAll() stops every job', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      const a = scheduler.schedule(config, '* * * * *');
      const b = scheduler.schedule(config, '* * * * *');

      scheduler.stopAll();

      expect(a.nextRunAt()).toBeUndefined();
      expect(b.nextRunAt()).toBeUndefined();
      expect(scheduler.listJobs()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5 * MINUTE_MS);
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('lets an in-flight run finish after stop() and still calls onComplete', async () => {
      const gate = createGatedNode();
      registry.register('@cognipipe/node-gated', gate.GatedNode);
      const gated = buildWorkflow([{ name: 'g', uses: '@cognipipe/node-gated', config: {} }]);
      const onComplete = jest.fn();
      const job = scheduler.schedule(gated, '* * * * *', { onComplete });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(job.isRunning()).toBe(true);

      job.stop();
      expect(job.nextRunAt()).toBeUndefined();
      expect(scheduler.listJobs()).toHaveLength(0);

      gate.release();
      await jest.advanceTimersByTimeAsync(0);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(job.isRunning()).toBe(false);
    });

    it('stops the job after its final run when no further fire time exists', async () => {
      // The 8-year search horizon makes this unreachable with a real expression
      // (the longest gap any valid cron produces is 8 years), so it is forced
      // by stubbing the second nextCronRun() call.
      const realNextCronRun = cron.nextCronRun;
      jest
        .spyOn(cron, 'nextCronRun')
        .mockImplementationOnce(realNextCronRun)
        .mockReturnValueOnce(undefined);
      const runSpy = jest.spyOn(executor, 'run');
      const job = scheduler.schedule(config, '* * * * *');

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(job.nextRunAt()).toBeUndefined();
      expect(scheduler.listJobs()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('overlap policy', () => {
    it("default 'skip' skips ticks while a long run is in flight, then resumes", async () => {
      const gate = createGatedNode();
      registry.register('@cognipipe/node-gated', gate.GatedNode);
      const gated = buildWorkflow([{ name: 'g', uses: '@cognipipe/node-gated', config: {} }]);
      const runSpy = jest.spyOn(executor, 'run');
      const job = scheduler.schedule(gated, '* * * * *');

      await jest.advanceTimersByTimeAsync(MINUTE_MS); // 00:01 — run 1 starts and holds
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(job.isRunning()).toBe(true);

      await jest.advanceTimersByTimeAsync(MINUTE_MS); // 00:02 — skipped
      await jest.advanceTimersByTimeAsync(MINUTE_MS); // 00:03 — skipped
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(job.nextRunAt()?.toISOString()).toBe('2026-01-01T00:04:00.000Z');

      gate.release();
      await jest.advanceTimersByTimeAsync(0);
      expect(job.isRunning()).toBe(false);

      await jest.advanceTimersByTimeAsync(MINUTE_MS); // 00:04 — run 2 starts
      expect(runSpy).toHaveBeenCalledTimes(2);
    });

    it("'allow' starts a second concurrent run while the first is in flight", async () => {
      const gate = createGatedNode();
      registry.register('@cognipipe/node-gated', gate.GatedNode);
      const gated = buildWorkflow([{ name: 'g', uses: '@cognipipe/node-gated', config: {} }]);
      const runSpy = jest.spyOn(executor, 'run');
      const job = scheduler.schedule(gated, '* * * * *', { overlap: 'allow' });

      await jest.advanceTimersByTimeAsync(MINUTE_MS); // run 1 starts and holds
      await jest.advanceTimersByTimeAsync(MINUTE_MS); // run 2 starts concurrently

      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(gate.started()).toBe(2);
      expect(job.isRunning()).toBe(true);

      gate.release();
      await jest.advanceTimersByTimeAsync(0);
      expect(job.isRunning()).toBe(false);
    });
  });

  describe('timer edge cases', () => {
    it('re-arms in chunks for far-future fire times without running early', async () => {
      // Mid-year: the next Jan 1 is ~183.5 days away, far beyond setTimeout's cap.
      jest.setSystemTime(new Date('2026-07-01T12:00:00Z'));
      const runSpy = jest.spyOn(executor, 'run');
      const job = scheduler.schedule(config, '0 0 1 1 *');
      const target = new Date('2027-01-01T00:00:00Z');
      expect(job.nextRunAt()?.toISOString()).toBe('2027-01-01T00:00:00.000Z');

      const totalDelay = target.getTime() - Date.now();
      expect(totalDelay).toBeGreaterThan(MAX_TIMER_DELAY_MS);

      await jest.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS); // the first chunk elapses
      expect(runSpy).not.toHaveBeenCalled();
      expect(job.nextRunAt()?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(totalDelay - MAX_TIMER_DELAY_MS);
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(config, {
        trigger: { type: 'schedule', cron: '0 0 1 1 *', scheduledAt: '2027-01-01T00:00:00.000Z' },
      });
    });

    it('an early timer fire re-arms instead of running', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      scheduler.schedule(config, '* * * * *');

      // The timer fires on schedule, but Date.now() still reads 1 ms before the tick.
      skewClock(-1);
      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(runSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(config, {
        trigger: { type: 'schedule', cron: '* * * * *', scheduledAt: TICK_1 },
      });
    });

    it('no backfill: a suspension spanning many ticks runs the job once, then resumes the normal cadence', async () => {
      const runSpy = jest.spyOn(executor, 'run');
      const job = scheduler.schedule(config, '* * * * *');

      // A process frozen for ~10 minutes: by the time the 00:01 timer finally
      // fires, the wall clock already reads 00:10.
      skewClock(9 * MINUTE_MS);
      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(runSpy).toHaveBeenCalledTimes(1);
      // The single run is for the originally scheduled minute…
      expect(runSpy).toHaveBeenCalledWith(config, {
        trigger: { type: 'schedule', cron: '* * * * *', scheduledAt: TICK_1 },
      });
      // …and the schedule continues from the next FUTURE tick, not from 00:02.
      expect(job.nextRunAt()?.toISOString()).toBe('2026-01-01T00:11:00.000Z');

      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(runSpy).toHaveBeenCalledTimes(2);
      expect(runSpy).toHaveBeenNthCalledWith(2, config, {
        trigger: { type: 'schedule', cron: '* * * * *', scheduledAt: '2026-01-01T00:11:00.000Z' },
      });
    });
  });

  describe('failure handling', () => {
    it('a rejecting run calls onError once and the job keeps scheduling', async () => {
      const failing = buildWorkflow([{ name: 'boom', uses: '@cognipipe/node-fail', config: {} }]);
      const onError = jest.fn();
      const job = scheduler.schedule(failing, '* * * * *', { onError });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(onError).toHaveBeenCalledTimes(1);
      const error = onError.mock.calls[0]?.[0];
      expect(isCogniPipeError(error)).toBe(true);
      expect((error as CogniPipeError).code).toBe(COGNIPIPE_ERROR_CODES.STEP_EXECUTION_FAILED);
      expect(onError).toHaveBeenCalledWith(expect.anything(), {
        jobId: job.id,
        scheduledFor: new Date(TICK_1),
      });
      expect(job.nextRunAt()).toBeDefined();

      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(onError).toHaveBeenCalledTimes(2);
    });

    it('with no onError, failures go to process.emitWarning and cause no unhandled rejection', async () => {
      const emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const failing = buildWorkflow([{ name: 'boom', uses: '@cognipipe/node-fail', config: {} }]);
      const job = scheduler.schedule(failing, '* * * * *');

      // Jest fails the running test on an unhandled rejection, so this test
      // also proves the rejected run is always handled.
      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
      const [message, type] = emitWarningSpy.mock.calls[0] ?? [];
      expect(message).toContain(`"${job.id}"`);
      expect(message).toContain('node failed');
      expect(type).toBe('CogniPipeSchedulerWarning');
      expect(job.nextRunAt()).toBeDefined();
    });

    it('reports a non-Error rejection reason through emitWarning', async () => {
      const emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      jest.spyOn(executor, 'run').mockRejectedValue('plain string failure');
      scheduler.schedule(config, '* * * * *');

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
      expect(emitWarningSpy.mock.calls[0]?.[0]).toContain('plain string failure');
    });

    it('a throwing onComplete is reported via emitWarning and never crashes the job', async () => {
      const emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const job = scheduler.schedule(config, '* * * * *', {
        onComplete: () => {
          throw new Error('callback exploded');
        },
      });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
      expect(emitWarningSpy.mock.calls[0]?.[0]).toContain('callback exploded');
      expect(job.nextRunAt()).toBeDefined();
    });

    it('a throwing onError falls back to emitWarning', async () => {
      const emitWarningSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const failing = buildWorkflow([{ name: 'boom', uses: '@cognipipe/node-fail', config: {} }]);
      const job = scheduler.schedule(failing, '* * * * *', {
        onError: () => {
          throw new Error('handler exploded');
        },
      });

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
      expect(emitWarningSpy.mock.calls[0]?.[0]).toContain('handler exploded');
      expect(job.nextRunAt()).toBeDefined();
    });
  });
});
