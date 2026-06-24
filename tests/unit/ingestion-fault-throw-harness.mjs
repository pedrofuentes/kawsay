// A real worker_threads stand-in that FAULTS at module-load time (mirrors a load
// error in ingestion-worker.ts / openIngestionContext, or a native crash before
// the job try/catch). Node emits an `error` EVENT on the Worker; with no host
// listener it propagates to the parent as an uncaughtException and crashes the
// Electron main process. Used by ingestion-thread-fault.test.ts to prove the
// host handle + coordinator contain the fault instead.
throw new Error('ingestion worker failed to initialise (simulated module-load fault)');
