# Cooperative task cancellation

Benchmark handlers currently cannot observe mid-iteration cancellation. If a task aborts while a handler is running, the handler may continue doing expensive work even though its result will be discarded.

Add a new Bench option, cooperativeAbortTimeout (milliseconds). When this option is greater than 0, every iteration must receive a fresh AbortSignal as the first handler argument. Signals must be independent per iteration and must never be reused.

The cooperative signal can be aborted by two mechanisms:
- External abort: if the task or bench abort signal fires during an iteration, the cooperative signal for that in-flight iteration must abort synchronously.
- Timeout abort (async only): if an async iteration exceeds cooperativeAbortTimeout, the cooperative signal must abort automatically.

Event rule: the cooperative-abort event is timeout-specific. Dispatch cooperative-abort only when timeout abort fires. Do not dispatch cooperative-abort for external abort-driven signal cancellation.

Counting and cleanup rules:
- If N iterations time out, exactly N cooperative-abort events must be dispatched for that task (including concurrency: 'task' mode).
- After a task run completes, no delayed/stale timeout should be able to emit additional cooperative-abort events.

Synchronous rule: runSync must still pass a cooperative signal when enabled, but timeout logic does not apply to synchronous execution. No timer-based cooperative-abort behavior should occur in sync handlers.

Typing is part of the contract, not optional. Update the public types so this behavior is represented in Fn, BenchOptions/BenchLike, BenchEvents, TaskEvents, and typed event listeners (including cooperative-abort).

The feature must work in all execution modes, including sequential execution, concurrency: 'task', and bench.runSync().

Add a working example at examples/src/cooperative-abort.ts. The example must execute successfully and demonstrate cooperative cancellation behavior, but its exact console output format is not prescribed.

Validation: passing a negative or non-finite cooperativeAbortTimeout (for example NaN or Infinity) must throw RangeError at Bench construction time, and the error message must include the option name.
