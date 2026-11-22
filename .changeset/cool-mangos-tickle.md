---
'@cognipipe/core': minor
---

Add `WorkflowScheduler` for cron-based workflow triggering. Schedule any validated workflow with a standard 5-field cron expression and it runs automatically through a `WorkflowExecutor`:

```ts
import { WorkflowScheduler } from '@cognipipe/core';

const scheduler = new WorkflowScheduler(executor);
scheduler.schedule(config, '0 9 * * 1-5', { id: 'weekday-report' });
```

Every scheduled run receives a reserved `trigger` value (`{ type: 'schedule', cron, scheduledAt }`), so steps can use `{{ trigger.scheduledAt }}`. The scheduler ships with a zero-dependency cron parser (`parseCron` and `nextCronRun`), UTC or host-local time, overlap control (`skip` or `allow`), per-job `onComplete` and `onError` callbacks (sync or async), and a new `SCHEDULE_INVALID` error code. Options are captured when `schedule()` is called. A failed run is reported but never stops the schedule. Missed runs are not backfilled: if the process was suspended, at most one overdue run is dispatched on resumption (for the first missed tick, with its original `scheduledAt`) and the other missed ticks are skipped. In host-local mode, a daylight-saving gap shifts a skipped wall time forward by the gap, and the repeated hour of a fall-back is not run twice, so a sub-hourly local schedule pauses during it. Use UTC when you need a steady cadence.
