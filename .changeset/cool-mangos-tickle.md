---
'@cognipipe/core': minor
---

Add `WorkflowScheduler` for cron-based workflow triggering. Schedule any validated workflow with a standard 5-field cron expression and it runs automatically through a `WorkflowExecutor`:

```ts
import { WorkflowScheduler } from '@cognipipe/core';

const scheduler = new WorkflowScheduler(executor);
scheduler.schedule(config, '0 9 * * 1-5', { id: 'weekday-report' });
```

Every scheduled run receives a reserved `trigger` value (`{ type: 'schedule', cron, scheduledAt }`), so steps can use `{{ trigger.scheduledAt }}`. The scheduler ships with a zero-dependency cron parser (`parseCron` and `nextCronRun`), UTC or host-local time, overlap control (`skip` or `allow`), per-job `onComplete` and `onError` callbacks, and a new `SCHEDULE_INVALID` error code. A failed run is reported but never stops the schedule, and runs missed while the process was suspended are not replayed.
