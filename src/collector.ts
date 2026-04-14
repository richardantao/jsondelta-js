import { TypedEmitter } from "./base";
import { getPath, setPath } from "./path";
import {
	type CollectorEvents,
	JsonPulseError,
	type MiddlewareFn,
	type StreamingChunk,
} from "./types";

/**
 * Collector — the client-side inverse of the Emitter.
 *
 * Consumes a stream of `StreamingChunk` patch operations and reconstructs
 * the original object incrementally. Transport is intentionally out of scope:
 * call `consume()` with each chunk as it arrives from whatever transport layer
 * your application uses (SSE, WebSocket, HTTP streaming, etc.).
 *
 * @example
 * const collector = new Collector<ReportDocument>();
 *
 * collector.on('change', (state) => setReport(state));
 * collector.on('complete', (final) => save(final));
 *
 * // Feed chunks from your transport
 * sseClient.onChunk((chunk: StreamingChunk) => collector.consume(chunk));
 *
 * // Signal end of stream
 * sseClient.onClose(() => collector.complete());
 *
 * @example Middleware — mirror summary → originalSummary
 * collector.use((patch, next) => {
 *   if (patch.path.endsWith('.summary')) {
 *     next(patch);
 *     next({ ...patch, path: patch.path.replace('.summary', '.originalSummary') });
 *     return;
 *   }
 *   next(patch);
 * });
 */
export class Collector<T = unknown> extends TypedEmitter<CollectorEvents<T>> {
	private working: Record<string, unknown> = {};
	private _state: Partial<T> = {};
	private middleware: MiddlewareFn[] = [];
	private _isComplete = false;
	// Tracks paths that have received their first patch — used to fire pathstart once
	private seenPaths = new Set<string>();

	// -------------------------------------------------------------------------
	// Middleware
	// -------------------------------------------------------------------------

	/**
	 * Register a middleware function.
	 * Middleware runs in registration order before each patch is applied.
	 * Returns `this` for chaining.
	 */
	use(fn: MiddlewareFn): this {
		this.middleware.push(fn);
		return this;
	}

	// -------------------------------------------------------------------------
	// Consuming patches
	// -------------------------------------------------------------------------

	/**
	 * Feed a single patch into the Collector.
	 * Runs the patch through the middleware chain, applies it to internal state,
	 * then emits a `change` event with a shallow clone of the current state.
	 */
	consume(chunk: StreamingChunk): void {
		if (this._isComplete) {
			throw new JsonPulseError(
				"Cannot consume patches after complete() has been called. Call reset() to reuse this Collector.",
			);
		}

		this.runMiddleware(chunk, (patched) => this.applyPatch(patched));
	}

	/**
	 * Signal that the stream has ended.
	 * Emits a `complete` event with the fully assembled state.
	 */
	complete(): void {
		if (this._isComplete) return;
		this._isComplete = true;
		this.emit("complete", this._state as T);
	}

	// -------------------------------------------------------------------------
	// State access
	// -------------------------------------------------------------------------

	/** Current partially-assembled state. */
	get value(): Partial<T> {
		return this._state;
	}

	get isComplete(): boolean {
		return this._isComplete;
	}

	// -------------------------------------------------------------------------
	// Reset
	// -------------------------------------------------------------------------

	/**
	 * Reset state and completion flag, preserving registered middleware and
	 * event listeners so the instance can be reused for a new stream.
	 */
	reset(): this {
		this.working = {};
		this._state = {};
		this._isComplete = false;
		this.seenPaths.clear();
		return this;
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	private applyPatch(chunk: StreamingChunk): void {
		const { path, value, op } = chunk;

		// complete patches don't mutate state — the value is the fully-assembled
		// snapshot delivered by the Emitter. Fire pathcomplete and return.
		if (op === "complete") {
			this.emit("pathcomplete", path, value);
			return;
		}

		// Fire pathstart BEFORE setPath so the value snapshot is the initial
		// type, not a version already mutated by subsequent patches in the same tick.
		if ((op === "add" || op === "insert") && !this.seenPaths.has(path)) {
			this.seenPaths.add(path);
			// Snapshot containers so the listener gets a stable {} or [] not mutated later
			const startValue =
				value !== null && typeof value === "object"
					? Array.isArray(value)
						? []
						: {}
					: value;
			this.emit("pathstart", path, startValue);
		}

		try {
			switch (op) {
				case "add": {
					setPath(this.working, path, value);
					break;
				}
				case "append": {
					const current = getPath(this.working, path, "") as string;
					setPath(this.working, path, current + (value as string));
					break;
				}
				case "insert": {
					const arr = getPath(this.working, path, []) as unknown[];
					setPath(this.working, path, [...arr, value]);
					break;
				}
				default: {
					throw new JsonPulseError(`Unknown op "${op}" at path "${path}"`);
				}
			}
		} catch (err) {
			const error =
				err instanceof JsonPulseError
					? err
					: new JsonPulseError(`Failed to apply patch at path "${path}"`, err);
			this.emit("error", error);
			return;
		}

		// Emit a shallow clone so React setState always receives a new reference.
		this._state = { ...this.working } as Partial<T>;
		this.emit("change", this._state);
	}

	/**
	 * Run the middleware chain, ultimately calling `apply` with the
	 * (possibly transformed) patch if it makes it through.
	 */
	private runMiddleware(
		chunk: StreamingChunk,
		apply: (chunk: StreamingChunk) => void,
	): void {
		if (this.middleware.length === 0) {
			apply(chunk);
			return;
		}

		const run = (index: number, current: StreamingChunk): void => {
			if (index >= this.middleware.length) {
				apply(current);
				return;
			}
			const middlewareFn = this.middleware[index];

			middlewareFn?.(current, (next) => run(index + 1, next));
		};

		run(0, chunk);
	}
}
