/**
 * The four operations a patch can carry.
 *
 * - `add`      — initialise or replace a value at a path (primitives, objects, arrays)
 * - `append`   — concatenate a string delta onto an existing string value
 * - `insert`   — push a new element onto an existing array
 * - `complete` — the value at this path is fully assembled. Carries the complete
 *                assembled value as a snapshot. Fired when the Emitter pops the
 *                stack — i.e. on `}`, `]`, closing `"`, or primitive termination.
 */
export type Op = "add" | "append" | "insert" | "complete";

/**
 * A single patch emitted by the Emitter and consumed by the Collector.
 *
 * All four ops share the same shape — `value` carries the patch payload for
 * data ops, and the fully-assembled snapshot for `complete`.
 *
 * @example
 * { path: 'title',         value: 'Hello',             op: 'add'      }
 * { path: 'title',         value: ' World',            op: 'append'   }
 * { path: 'title',         value: 'Hello World',       op: 'complete' }
 * { path: 'sections[0].heading', value: 'Exec',                 op: 'add'      }
 * { path: 'sections[0].heading', value: 'utive Summary',        op: 'append'   }
 * { path: 'sections[0].heading', value: 'Executive Summary',    op: 'complete' }
 * { path: 'sections[0]',         value: { heading: '...' },     op: 'complete' }
 * { path: 'sections',            value: [{ heading: '...' }],   op: 'complete' }
 */
export interface StreamingChunk {
	path: string;
	value: unknown;
	op: Op;
}

/**
 * Middleware function signature.
 *
 * Receives the current patch and a `next` callback.
 * Call `next(patch)` to pass the patch through (optionally transformed).
 * Call `next` multiple times to fan out (e.g. mirroring a field).
 * Return without calling `next` to drop the patch entirely.
 *
 * @example
 * const mirror: MiddlewareFn = (patch, next) => {
 *   if (patch.path.endsWith('.summary')) {
 *     next(patch);
 *     next({ ...patch, path: patch.path.replace('.summary', '.originalSummary') });
 *     return;
 *   }
 *   next(patch);
 * };
 */
export type MiddlewareFn = (
	patch: StreamingChunk,
	next: (patch: StreamingChunk) => void,
) => void;

/** Events the Collector can emit. */
export interface CollectorEvents<T> {
	/**
	 * Fires on every data patch (`add`, `append`, `insert`) with the current
	 * partially-assembled state.
	 */
	change: (state: Partial<T>) => void;

	/**
	 * Fires once when the stream ends with the fully assembled object.
	 */
	complete: (state: T) => void;

	/**
	 * Fires the first time a path receives a data patch within this stream.
	 * `value` is a snapshot of the initial value at that path.
	 * Resets when `reset()` is called.
	 *
	 * @example
	 * collector.on('pathstart', (path, value) => {
	 *   if (/^sections\[\d+\]$/.test(path)) showSectionSkeleton(path);
	 * });
	 */
	pathstart: (path: string, value: unknown) => void;

	/**
	 * Fires when a value at a path is fully assembled — no further patches
	 * will modify it. `value` is the complete assembled snapshot delivered
	 * directly from the `complete` patch.
	 *
	 * Use this to render sub-values as soon as they're sealed without waiting
	 * for the entire stream to complete. The value is safe to store — it is
	 * a snapshot, not a live reference.
	 *
	 * @example
	 * collector.on('pathcomplete', (path, value) => {
	 *   if (/^sections\[\d+\]$/.test(path)) appendSection(value);
	 * });
	 */
	pathcomplete: (path: string, value: unknown) => void;

	error: (err: JsonCurrentError) => void;
}

/** Events the Emitter can emit. */
export interface EmitterEvents {
	patch: (chunk: StreamingChunk) => void;
	complete: () => void;
	error: (err: JsonCurrentError) => void;
}

export class JsonCurrentError extends Error {
	readonly cause?: unknown;
	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "JsonCurrentError";
		this.cause = cause;
	}
}
