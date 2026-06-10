import type {
  AddEventListenerOptionsArgument,
  BenchLike,
  EventListener,
  EventListenerObject,
  Fn,
  FnOptions,
  RemoveEventListenerOptionsArgument,
  Samples,
  TaskEvents,
  TaskResult,
  TaskResultRuntimeInfo,
  TaskResultTimestampProviderInfo,
  TimestampFn,
  TimestampProvider,
  TimestampValue,
} from './types'

import { BenchEvent } from './event'
import {
  assert,
  computeStatistics,
  isFnAsyncResource,
  isPromiseLike,
  isValidSamples,
  sortSamples,
  toError,
  withConcurrency,
} from './utils'

/**
 * The names of all supported task lifecycle hooks.
 */
const hookNames = ['afterAll', 'beforeAll', 'beforeEach', 'afterEach'] as const

/**
 * Task states that can be aborted.
 */
const abortableStates = ['not-started', 'started'] as const

/**
 * Default task result for tasks that have not yet started.
 */
const notStartedTaskResult: TaskResult = { state: 'not-started' }

/**
 * Default task result for tasks that have been aborted.
 */
const abortedTaskResult: TaskResult = { state: 'aborted' }

/**
 * Default task result for tasks that have started running.
 */
const startedTaskResult: TaskResult = { state: 'started' }

/**
 * A class that represents each benchmark task in Tinybench. It keeps track of the
 * results, name, the task function, the number times the task function has been executed, ...
 */
export class Task extends EventTarget {
  declare addEventListener: <K extends TaskEvents>(
    type: K,
    listener: EventListener<K, 'task'> | EventListenerObject<K, 'task'> | null,
    options?: AddEventListenerOptionsArgument
  ) => void

  declare removeEventListener: <K extends TaskEvents>(
    type: K,
    listener: EventListener<K, 'task'> | EventListenerObject<K, 'task'> | null,
    options?: RemoveEventListenerOptionsArgument
  ) => void

  /**
   * The name of the task.
   * @returns The task name as a string
   */
  get name (): string {
    return this.#name
  }

  /**
   * The result of the task.
   * @returns The task result including state, statistics, and runtime information
   */
  get result (): TaskResult &
    TaskResultRuntimeInfo &
    TaskResultTimestampProviderInfo {
    return {
      ...this.#result,
      runtime: this.#bench.runtime,
      runtimeVersion: this.#bench.runtimeVersion,
      timestampProviderName: this.#bench.timestampProvider.name,
    }
  }

  /**
   * The number of times the task function has been executed.
   * @returns The total number of executions performed
   */
  get runs (): number {
    return this.#runs
  }

  /**
   * Check if either our signal or the bench-level signal is aborted.
   */
  #aborted = false

  /**
   * Set of per-iteration cooperative AbortControllers that are currently
   * in-flight. Created fresh for each iteration when cooperativeAbortTimeout > 0
   * (sequential path). Aborted synchronously by #onAbort() and cleared on reset().
   */
  #activeCoopControllers = new Set<AbortController>()

  /**
   * Per-iteration cooperative timeout handles that are currently pending
   * (sequential async path). Tracked so an external abort can synchronously
   * cancel them via #onAbort(); otherwise a long-running, externally-aborted
   * iteration would later fire its timer and emit a spurious
   * `cooperative-abort` event, which is reserved for timeout-driven aborts.
   */
  #activeCoopTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * The task asynchronous status
   */
  readonly #async: boolean

  /**
   * The Bench instance reference
   */
  readonly #bench: BenchLike

  /**
   * The task function
   */
  readonly #fn: Fn

  /**
   * The task function options
   */
  readonly #fnOpts: Readonly<FnOptions>

  /**
   * The task name
   */
  readonly #name: string

  /**
   * The result object
   */
  #result: TaskResult = notStartedTaskResult

  /**
   * Retain samples
   */
  readonly #retainSamples: boolean

  /**
   * The number of times the task function has been executed
   */
  #runs = 0

  /**
   * The task-level abort signal
   */
  readonly #signal: AbortSignal | undefined

  /**
   * The timestamp function
   */
  readonly #timestampFn: TimestampFn

  /**
   * The timestamp provider
   */
  readonly #timestampProvider: TimestampProvider

  /**
   * The timestamp to milliseconds conversion function
   */
  readonly #timestampToMs: (value: TimestampValue) => number

  constructor (bench: BenchLike, name: string, fn: Fn, fnOpts: FnOptions = {}) {
    super()
    this.#bench = bench
    this.#name = name
    this.#fn = fn
    this.#fnOpts = fnOpts
    this.#async = fnOpts.async ?? isFnAsyncResource(fn)
    this.#signal = fnOpts.signal
    this.#retainSamples = fnOpts.retainSamples ?? bench.retainSamples
    this.#timestampProvider = bench.timestampProvider
    this.#timestampFn = bench.timestampProvider.fn
    this.#timestampToMs = bench.timestampProvider.toMs

    for (const hookName of hookNames) {
      if (this.#fnOpts[hookName] != null) {
        assert(
          typeof this.#fnOpts[hookName] === 'function',
          `'${hookName}' must be a function if provided`
        )
      }
    }

    this.reset(false)

    if (this.#signal) {
      if (this.#signal.aborted) {
        this.#onAbort()
      } else {
        this.#signal.addEventListener('abort', this.#onAbort.bind(this), {
          once: true,
        })
      }
    }

    if (this.#bench.signal) {
      if (this.#bench.signal.aborted) {
        this.#onAbort()
      } else {
        this.#bench.signal.addEventListener('abort', this.#onAbort.bind(this), {
          once: true,
        })
      }
    }
  }

  /**
   * Resets the task to make the `Task.runs` a zero-value and remove the `Task.result` object property.
   * @param emit - whether to emit the `reset` event or not
   */
  reset (emit = true): void {
    for (const ctrl of this.#activeCoopControllers) {
      ctrl.abort()
    }
    this.#activeCoopControllers.clear()
    for (const timer of this.#activeCoopTimers) {
      clearTimeout(timer)
    }
    this.#activeCoopTimers.clear()
    this.#runs = 0
    this.#result = this.#aborted ? abortedTaskResult : notStartedTaskResult

    if (emit) this.dispatchEvent(new BenchEvent('reset', this))
  }

  /**
   * Runs the current task and writes the results in `Task.result` object property.
   * @returns the current task
   */
  async run (): Promise<Task> {
    if (this.#result.state !== 'not-started') {
      return this
    }
    this.#result = { state: 'started' }
    this.dispatchEvent(new BenchEvent('start', this))
    await this.#bench.setup(this, 'run')
    const { error, samples: latencySamples } = await this.#benchmark(
      'run',
      this.#bench.time,
      this.#bench.iterations
    )
    await this.#bench.teardown(this, 'run')

    this.#processRunResult({ error, latencySamples })

    return this
  }

  /**
   * Runs the current task synchronously and writes the results in `Task.result` object property.
   * @returns the current task
   */
  runSync (): this {
    if (this.#result.state !== 'not-started') {
      return this
    }

    assert(
      this.#bench.concurrency === null,
      'Cannot use `concurrency` option when using `runSync`'
    )
    this.#result = startedTaskResult
    this.dispatchEvent(new BenchEvent('start', this))

    const setupResult = this.#bench.setup(this, 'run')
    assert(
      !isPromiseLike(setupResult),
      '`setup` function must be sync when using `runSync()`'
    )

    const { error, samples: latencySamples } = this.#benchmarkSync(
      'run',
      this.#bench.time,
      this.#bench.iterations
    )

    const teardownResult = this.#bench.teardown(this, 'run')
    assert(
      !isPromiseLike(teardownResult),
      '`teardown` function must be sync when using `runSync()`'
    )

    this.#processRunResult({ error, latencySamples })

    return this
  }

  /**
   * Warms up the current task.
   */
  async warmup (): Promise<void> {
    if (this.#result.state !== 'not-started') {
      return
    }
    this.dispatchEvent(new BenchEvent('warmup', this))
    await this.#bench.setup(this, 'warmup')
    const { error } = await this.#benchmark(
      'warmup',
      this.#bench.warmupTime,
      this.#bench.warmupIterations
    )
    await this.#bench.teardown(this, 'warmup')

    this.#postWarmup(error)
  }

  /**
   * Warms up the current task synchronously.
   */
  warmupSync (): void {
    if (this.#result.state !== 'not-started') {
      return
    }

    this.dispatchEvent(new BenchEvent('warmup', this))

    const setupResult = this.#bench.setup(this, 'warmup')
    assert(
      !isPromiseLike(setupResult),
      '`setup` function must be sync when using `runSync()`'
    )

    const { error } = this.#benchmarkSync(
      'warmup',
      this.#bench.warmupTime,
      this.#bench.warmupIterations
    )

    const teardownResult = this.#bench.teardown(this, 'warmup')
    assert(
      !isPromiseLike(teardownResult),
      '`teardown` function must be sync when using `runSync()`'
    )

    this.#postWarmup(error)
  }

  async #benchmark (
    mode: 'run' | 'warmup',
    time: number,
    iterations: number
  ): Promise<
    { error: Error; samples?: never } | { error?: never; samples?: Samples }
  > {
    try {
      if (this.#fnOpts.beforeAll) {
        await this.#fnOpts.beforeAll.call(this, mode)
      }

      let totalTime = 0 // ms
      const samples: number[] = []

      // Accept an optional cooperative signal provided by withConcurrency in
      // concurrency:'task' mode; undefined in the sequential path causes
      // #measure / #measureSync to create their own per-iteration controller.
      const benchmarkTask = async (coopSignal?: AbortSignal) => {
        if (this.#aborted) {
          return
        }
        try {
          if (this.#fnOpts.beforeEach != null) {
            await this.#fnOpts.beforeEach.call(this, mode)
          }

          const taskTime = this.#async
            ? await this.#measure(coopSignal)
            : this.#measureSync(coopSignal)

          samples.push(taskTime)
          totalTime += taskTime
        } finally {
          if (this.#fnOpts.afterEach != null) {
            await this.#fnOpts.afterEach.call(this, mode)
          }
        }
      }

      if (this.#bench.concurrency === 'task') {
        await withConcurrency({
          cooperativeAbortTimeout: this.#bench.cooperativeAbortTimeout ?? 0,
          fn: benchmarkTask,
          iterations,
          limit: Math.max(1, Math.floor(this.#bench.threshold)),
          onCooperativeAbort: () => {
            this.dispatchEvent(new BenchEvent('cooperative-abort', this))
            this.#bench.dispatchEvent(new BenchEvent('cooperative-abort', this))
          },
          // Wire BOTH upstream signals: a task-level and a bench-level signal
          // can each independently cancel the run, and either one must
          // synchronously abort the in-flight cooperative signals.
          signals: [this.#signal, this.#bench.signal],
          time,
          timestampProvider: this.#timestampProvider,
        })
        this.#runs = samples.length
      } else {
        while (
          // eslint-disable-next-line no-unmodified-loop-condition
          (totalTime < time || samples.length < iterations) &&
          !this.#aborted
        ) {
          await benchmarkTask()
        }
      }

      if (this.#fnOpts.afterAll != null) {
        await this.#fnOpts.afterAll.call(this, mode)
      }

      return isValidSamples(samples) ? { samples } : {}
    } catch (error) {
      return { error: toError(error) }
    }
  }

  /**
   * @param mode - 'run' | 'warmup'
   * @param time - the amount of time to run the benchmark
   * @param iterations - the amount of iterations to run the benchmark
   * @returns the error if any, and the samples if any
   */
  #benchmarkSync (
    mode: 'run' | 'warmup',
    time: number,
    iterations: number
  ): { error: Error; samples?: never } | { error?: never; samples?: Samples } {
    try {
      if (this.#fnOpts.beforeAll) {
        const beforeAllResult = this.#fnOpts.beforeAll.call(this, mode)
        assert(
          !isPromiseLike(beforeAllResult),
          '`beforeAll` function must be sync when using `runSync()`'
        )
      }

      let totalTime = 0
      const samples: number[] = []

      const benchmarkTask = () => {
        if (this.#aborted) {
          return
        }
        try {
          if (this.#fnOpts.beforeEach) {
            const beforeEachResult = this.#fnOpts.beforeEach.call(this, mode)
            assert(
              !isPromiseLike(beforeEachResult),
              '`beforeEach` function must be sync when using `runSync()`'
            )
          }

          const taskTime = this.#measureSync()

          samples.push(taskTime)
          totalTime += taskTime
        } finally {
          if (this.#fnOpts.afterEach) {
            const afterEachResult = this.#fnOpts.afterEach.call(this, mode)
            assert(
              !isPromiseLike(afterEachResult),
              '`afterEach` function must be sync when using `runSync()`'
            )
          }
        }
      }

      while (
        // eslint-disable-next-line no-unmodified-loop-condition
        (totalTime < time || samples.length < iterations) &&
        !this.#aborted
      ) {
        benchmarkTask()
      }

      if (this.#fnOpts.afterAll) {
        const afterAllResult = this.#fnOpts.afterAll.call(this, mode)
        assert(
          !isPromiseLike(afterAllResult),
          '`afterAll` function must be sync when using `runSync()`'
        )
      }
      return isValidSamples(samples) ? { samples } : {}
    } catch (error) {
      return { error: toError(error) }
    }
  }

  /**
   * Measures a single execution of the task function asynchronously.
   * When called without an external cooperative signal (sequential path),
   * creates its own per-iteration AbortController and starts a timer for
   * `cooperativeAbortTimeout` ms. When the timer fires, the signal is aborted
   * and a `'cooperative-abort'` event is dispatched on the task.
   * When called with an external signal (concurrent path via withConcurrency),
   * the provided signal is used directly.
   * @param externalCoopSignal - cooperative AbortSignal provided by withConcurrency (concurrent path)
   * @returns The measured execution time
   */
  async #measure (externalCoopSignal?: AbortSignal): Promise<number> {
    const cooperativeAbortTimeout = this.#bench.cooperativeAbortTimeout ?? 0
    let iterCtrl: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let coopSignal = externalCoopSignal

    // In the sequential path no external signal is provided — create our own
    // per-iteration controller and start the cooperative timeout timer.
    if (coopSignal === undefined && cooperativeAbortTimeout > 0) {
      iterCtrl = new AbortController()
      this.#activeCoopControllers.add(iterCtrl)
      coopSignal = iterCtrl.signal
      timer = setTimeout(() => {
        iterCtrl!.abort() // eslint-disable-line @typescript-eslint/no-non-null-assertion
        this.#activeCoopControllers.delete(iterCtrl!) // eslint-disable-line @typescript-eslint/no-non-null-assertion
        this.#activeCoopTimers.delete(timer!) // eslint-disable-line @typescript-eslint/no-non-null-assertion
        // Notify listeners that this iteration's cooperative signal was fired
        // by the timeout (not by an external hard abort).
        const ev = new BenchEvent('cooperative-abort', this)
        this.dispatchEvent(ev)
        this.#bench.dispatchEvent(ev)
      }, cooperativeAbortTimeout)
      this.#activeCoopTimers.add(timer)
    }

    try {
      const taskStart = this.#timestampFn() as unknown as number
      // eslint-disable-next-line no-useless-call
      const fnResult = await this.#fn.call(this, coopSignal)
      const taskTime = this.#timestampToMs(
        (this.#timestampFn() as unknown as number) - taskStart
      )

      const overriddenDuration = getOverriddenDurationFromFnResult(fnResult)
      if (overriddenDuration !== undefined) {
        return overriddenDuration
      }
      return taskTime
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
        this.#activeCoopTimers.delete(timer)
      }
      if (iterCtrl !== undefined) this.#activeCoopControllers.delete(iterCtrl)
    }
  }

  /**
   * Measures a single execution of the task function synchronously.
   * Creates a fresh per-iteration AbortController for each call so that each
   * synchronous iteration receives an independent, non-pre-aborted signal.
   * No timer is started — timers cannot fire during synchronous execution —
   * but `#onAbort()` can still abort the controller synchronously if the
   * task's abort signal fires from within the handler itself.
   * @param externalCoopSignal - cooperative AbortSignal provided externally (reserved for future use)
   * @returns The measured execution time
   */
  #measureSync (externalCoopSignal?: AbortSignal): number {
    const cooperativeAbortTimeout = this.#bench.cooperativeAbortTimeout ?? 0
    let iterCtrl: AbortController | undefined
    let coopSignal = externalCoopSignal

    if (coopSignal === undefined && cooperativeAbortTimeout > 0) {
      iterCtrl = new AbortController()
      this.#activeCoopControllers.add(iterCtrl)
      coopSignal = iterCtrl.signal
      // No timer: setTimeout cannot fire during synchronous execution.
      // The signal can still be aborted synchronously by #onAbort() if the
      // handler itself triggers the task's abort signal.
    }

    try {
      const taskStart = this.#timestampFn() as unknown as number
      // eslint-disable-next-line no-useless-call
      const fnResult = this.#fn.call(this, coopSignal)
      const taskTime = this.#timestampToMs(
        (this.#timestampFn() as unknown as number) - taskStart
      )

      assert(
        !isPromiseLike(fnResult),
        'task function must be sync when using `runSync()`'
      )
      const overriddenDuration = getOverriddenDurationFromFnResult(fnResult)
      if (overriddenDuration !== undefined) {
        return overriddenDuration
      }
      return taskTime
    } finally {
      if (iterCtrl !== undefined) this.#activeCoopControllers.delete(iterCtrl)
    }
  }

  /**
   * Handles the abort event from either the task-level or bench-level signal.
   * Synchronously aborts all in-flight per-iteration cooperative controllers,
   * then sets the task result to aborted if the task is in an abortable state.
   */
  #onAbort (): void {
    this.#aborted = true
    // Synchronously abort every in-flight per-iteration cooperative controller
    // so handlers can observe the abort with zero awaits.
    for (const ctrl of this.#activeCoopControllers) {
      ctrl.abort()
    }
    this.#activeCoopControllers.clear()
    // Cancel any pending cooperative timeout handles. An external abort is not
    // a timeout, so it must not be able to emit a (timeout-only)
    // `cooperative-abort` event later — even if the iteration keeps running.
    for (const timer of this.#activeCoopTimers) {
      clearTimeout(timer)
    }
    this.#activeCoopTimers.clear()
    if (
      abortableStates.includes(
        this.#result.state as (typeof abortableStates)[number]
      )
    ) {
      this.#result = abortedTaskResult
      const ev = new BenchEvent('abort', this)
      this.dispatchEvent(ev)
      this.#bench.dispatchEvent(ev)
    }
  }

  /**
   * Processes the result of the warmup phase.
   * Dispatches an error event if the warmup encountered an error.
   * @param error - The error that occurred during warmup, if any
   */
  #postWarmup (error: Error | undefined): void {
    if (error) {
      /* eslint-disable perfectionist/sort-objects */
      this.#result = { state: 'errored', error }
      /* eslint-enable perfectionist/sort-objects */
      const ev = new BenchEvent('error', this, error)
      this.dispatchEvent(ev)
      this.#bench.dispatchEvent(ev)
      if (this.#bench.throws) {
        throw error
      }
    }
  }

  /**
   * Processes the result of a benchmark run and updates the task result.
   * Calculates statistics from the collected samples and dispatches appropriate events.
   * @param options - An object containing the error and latency samples from the run
   * @param options.error - The error that occurred during the run, if any
   * @param options.latencySamples - The array of latency samples collected during the run
   */
  #processRunResult ({
    error,
    latencySamples,
  }: {
    error?: Error
    latencySamples?: number[]
  }): void {
    if (isValidSamples(latencySamples)) {
      this.#runs = latencySamples.length

      sortSamples(latencySamples)

      const latencyStatistics = computeStatistics(
        latencySamples,
        this.#retainSamples
      )
      const latencyStatisticsMean = latencyStatistics.mean

      let totalTime = 0
      const throughputSamples: Samples | undefined = [] as unknown as Samples

      for (const sample of latencySamples) {
        if (sample !== 0) {
          totalTime += sample
          throughputSamples.push(1000 / sample)
        } else {
          throughputSamples.push(
            latencyStatisticsMean === 0 ? 0 : 1000 / latencyStatisticsMean
          )
        }
      }

      sortSamples(throughputSamples)
      const throughputStatistics = computeStatistics(
        throughputSamples,
        this.#retainSamples
      )

      /* eslint-disable perfectionist/sort-objects */
      this.#result = {
        state: this.#aborted ? 'aborted-with-statistics' : 'completed',
        latency: latencyStatistics,
        period: totalTime / this.runs,
        throughput: throughputStatistics,
        totalTime,
      }
      /* eslint-enable perfectionist/sort-objects */
    } else if (this.#aborted) {
      // If aborted with no samples, still set the aborted flag
      this.#result = abortedTaskResult
    }

    if (error) {
      /* eslint-disable perfectionist/sort-objects */
      this.#result = {
        state: 'errored',
        error,
      }
      /* eslint-enable perfectionist/sort-objects */
      const ev = new BenchEvent('error', this, error)
      this.dispatchEvent(ev)
      this.#bench.dispatchEvent(ev)
      if (this.#bench.throws) {
        throw error
      }
    }

    const ev = new BenchEvent('cycle', this)
    this.dispatchEvent(ev)
    this.#bench.dispatchEvent(ev)
    // cycle and complete are equal in Task
    this.dispatchEvent(new BenchEvent('complete', this))
  }
}

/**
 * Extracts the overridden duration from a task function result if present.
 * @param fnResult - The result of the task function
 * @returns The overridden duration in milliseconds if defined by the function, otherwise undefined
 */
function getOverriddenDurationFromFnResult (
  fnResult: ReturnType<Fn>
): number | undefined {
  return fnResult != null &&
    typeof fnResult === 'object' &&
    'overriddenDuration' in fnResult &&
    typeof fnResult.overriddenDuration === 'number' &&
    Number.isFinite(fnResult.overriddenDuration) &&
    fnResult.overriddenDuration >= 0
    ? fnResult.overriddenDuration
    : undefined
}
