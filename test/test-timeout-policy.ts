// Upstream caps every test at 5 s. This fork adds a real-srt network regression that runs
// several sandboxed commands against a live listener and needs 10 s; the cap guards against
// runaway timeouts, not this intentional integration test.
export const maximumTestTimeoutMs = 10_000;

export type TimeoutTask = {
  name: string;
  type: string;
  timeout?: number;
  tasks?: readonly TimeoutTask[];
};

export function assertTestTasksWithinCap(tasks: readonly TimeoutTask[]): void {
  for (const task of tasks) {
    if (task.type === "test") {
      assertTestTimeoutWithinCap(task.timeout, task.name);
    }
    if (task.tasks) assertTestTasksWithinCap(task.tasks);
  }
}

export function assertTestTimeoutWithinCap(timeoutMs: number | undefined, testName: string): void {
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= maximumTestTimeoutMs) {
    return;
  }
  throw new Error(
    `Test ${JSON.stringify(testName)} has a ${timeoutMs} ms timeout; the maximum is ${maximumTestTimeoutMs} ms`,
  );
}
