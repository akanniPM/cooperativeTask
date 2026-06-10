import { Bench } from '../../src'

/**
 * Demonstrates cooperative task cancellation via `cooperativeAbortTimeout`.
 *
 * Each iteration receives a fresh AbortSignal. Two conditions fire it:
 *  - The task's external abort signal fires synchronously during an iteration.
 *  - The iteration exceeds `cooperativeAbortTimeout` milliseconds (async only).
 *
 * When the timer fires the task emits a 'cooperative-abort' event.
 */

const bench = new Bench({
  cooperativeAbortTimeout: 100, // abort slow iterations after 100 ms
  iterations: 3,
  time: 0,
  warmup: false,
})

bench.add('fast task', async (_signal) => {
  // Completes well within the 100 ms timeout — signal never fires.
  await new Promise<void>(resolve => setTimeout(resolve, 10))
})

bench.add('slow task', async (signal) => {
  // Would run 500 ms, but the cooperative signal fires at ~100 ms.
  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 500)
    signal?.addEventListener('abort', () => {
      clearTimeout(fallback)
      resolve()
    }, { once: true })
    if (signal?.aborted) {
      clearTimeout(fallback)
      resolve()
    }
  })
})

for (const task of bench.tasks) {
  task.addEventListener('cooperative-abort', () => {
    console.log(`cooperative-abort fired on: ${task.name}`)
  })
}

await bench.run()
console.table(bench.table())
