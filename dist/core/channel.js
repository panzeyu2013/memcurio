export class WorkerModelError extends Error {
    kind;
    /** Stable host-routing code (e.g. ABORTED / TIMEOUT) when available. */
    code;
    /** HTTP status the provider returned, when available. */
    status;
    constructor(message, kind, opts = {}) {
        super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
        this.name = "WorkerModelError";
        this.kind = kind;
        this.code = opts.code;
        this.status = opts.status;
    }
}
/** The caller (session retire, plugin unload, run budget) aborted the call. */
export class WorkerAbortedError extends WorkerModelError {
    constructor(message, code) {
        super(message, "aborted", { code });
        this.name = "WorkerAbortedError";
    }
}
/** The call stalled past the host idle watchdog or our run budget. */
export class WorkerTimeoutError extends WorkerModelError {
    constructor(message, code) {
        super(message, "timeout", { code });
        this.name = "WorkerTimeoutError";
    }
}
export class WorkerProviderError extends WorkerModelError {
    constructor(message, opts = {}) {
        super(message, "provider", opts);
        this.name = "WorkerProviderError";
    }
}
