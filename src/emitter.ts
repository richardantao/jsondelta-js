import { TypedEmitter } from "./base";
import {
	type EmitterEvents,
	JsonPulseError,
	type StreamingChunk,
} from "./types";

// ---------------------------------------------------------------------------
// Internal FSM types
// ---------------------------------------------------------------------------

const State = {
	START: 0,
	OBJECT_KEY: 1, // inside an object, expecting a quoted key
	OBJECT_KEY_STRING: 2, // inside the key string itself
	AFTER_KEY: 3, // key parsed, expecting ':'
	OBJECT_VALUE: 4, // after ':', expecting a value
	STRING_VALUE: 5, // inside a string value
	NUMBER_VALUE: 6, // accumulating digits / decimal / exponent
	BOOLEAN_VALUE: 7, // accumulating t/f/r/u/e/a/l/s literal
	NULL_VALUE: 8, // accumulating n/u/l/l literal
	ARRAY_VALUE: 9, // inside an array, expecting a value or ']'
	AFTER_VALUE: 10, // after a complete value, expecting ',' or close
	UNICODE_ESCAPE: 11, // inside \uXXXX sequence
} as const;
type State = (typeof State)[keyof typeof State];

interface StackEntry {
	type: 0 | 1; // 0 = object, 1 = array — numeric for fast comparison
	basePath: string;
	index: number; // -1 means "not yet incremented" for arrays
	value: unknown; // accumulates this entry's own assembled value
}

// Character code constants — avoid repeated string comparisons in hot path
const CC_QUOTE = 0x22; // "
const CC_COMMA = 0x2c; // ,
const CC_MINUS = 0x2d; // -
const CC_SLASH_FWD = 0x2f; // /
const CC_COLON = 0x3a; // :
const CC_LBRACKET = 0x5b; // [
const CC_BACKSLASH = 0x5c; // \
const CC_RBRACKET = 0x5d; // ]
const CC_LBRACE = 0x7b; // {
const CC_RBRACE = 0x7d; // }
const CC_b = 0x62;
const CC_f = 0x66;
const CC_n = 0x6e;
const CC_r = 0x72;
const CC_t = 0x74;
const CC_u = 0x75;
const CC_0 = 0x30;
const CC_9 = 0x39;
const CC_SP = 0x20; // space
const CC_NL = 0x0a; // \n
const CC_CR = 0x0d; // \r
const CC_TAB = 0x09; // \t

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Emitter — server-side streaming JSON parser.
 *
 * Consumes raw JSON tokens as they arrive from an LLM response stream and
 * emits `StreamingChunk` patch operations. Designed to be transport-agnostic:
 * feed tokens via `write()` from any source (Anthropic SDK, OpenAI SDK, etc.)
 * and call `flush()` when the stream ends.
 *
 * Each emitted chunk follows the `StreamingChunk` contract:
 *   `{ path, value, op }` where op is `'add' | 'append' | 'insert'`
 *
 * Performance notes:
 * - Uses an offset-based buffer scan modelled on jsonriver's Input class.
 *   Plain string characters in STRING_VALUE are batched into a single patch
 *   per write() call rather than one patch per character.
 * - Character comparisons use numeric char codes throughout the hot path.
 * - StackEntry.type uses 0/1 integers rather than string literals.
 * - Full \uXXXX unicode escape decoding including surrogate pairs.
 *
 * @example — Node.js with Anthropic SDK
 * ```ts
 * const emitter = new Emitter({ root: 'prediction' });
 *
 * emitter.on('patch', (chunk) => {
 *   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
 * });
 * emitter.on('complete', () => res.end());
 *
 * const stream = await anthropic.messages.stream({ ... });
 * for await (const event of stream) {
 *   if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
 *     emitter.write(event.delta.text);
 *   }
 * }
 * emitter.flush();
 * ```
 */
export class Emitter extends TypedEmitter<EmitterEvents> {
	private readonly root: string;
	private readonly completions: boolean;

	// FSM state
	private state: State = State.START;
	private stack: StackEntry[] = [];

	// Buffer — the current write()'s token string plus a cross-token carry
	// We keep a persistent `buf` + `pos` so that cross-token state (e.g. a
	// \uXXXX spanning two tokens) is handled without special-casing.
	private buf = "";
	private pos = 0;

	// Accumulators
	private keyBuf = ""; // object key being assembled
	private valBuf = ""; // number / boolean / null literal being assembled

	// String-value tracking
	private stringInitialised = false;
	// True when a backslash arrived at end-of-token; escape char is in next token
	private pendingEscape = false;

	// \uXXXX state — accumulates exactly 4 hex digits across token boundaries
	private unicodeBuf = "";
	// When we hit a high surrogate we hold it here until the low arrives
	private highSurrogate = 0;

	constructor(
		options: {
			/**
			 * Namespace prefix for all emitted paths.
			 * @example `{ root: 'prediction' }` → paths like `prediction.title`
			 */
			root?: string;
			/**
			 * Whether to emit `complete` patches when a value at a path is fully
			 * assembled. Enables the Collector's `pathcomplete` event.
			 *
			 * Defaults to `true`. Set to `false` on high-throughput routes where
			 * the wire overhead of completion signals is not worth the cost and
			 * `pathcomplete` is not used.
			 */
			completions?: boolean;
		} = {},
	) {
		super();
		this.root = options.root ?? "";
		this.completions = options.completions ?? true;
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Feed a raw JSON token into the parser.
	 * May emit zero or more `patch` events synchronously before returning.
	 */
	write(token: string): void {
		// Append to carry buffer and process from current pos.
		// We keep buf/pos persistent so that cross-token state works naturally.
		this.buf += token;
		this.process();
		// Commit consumed portion to avoid unbounded growth.
		// We only carry forward unprocessed bytes (pos < buf.length only when
		// we're mid-string and waiting for more input).
		if (this.pos > 0) {
			this.buf = this.buf.slice(this.pos);
			this.pos = 0;
		}
	}

	/**
	 * Signal end of stream.
	 * Finalises any pending primitive accumulator, then emits `complete`.
	 */
	flush(): void {
		this.finalise();
		this.emit("complete");
		this.reset();
	}

	/**
	 * Reset internal state without emitting `complete`.
	 * Preserves event listeners and root option for reuse.
	 */
	reset(): void {
		this.state = State.START;
		this.stack = [];
		this.buf = "";
		this.pos = 0;
		this.keyBuf = "";
		this.valBuf = "";
		this.stringInitialised = false;
		this.pendingEscape = false;
		this.unicodeBuf = "";
		this.highSurrogate = 0;
	}

	// -------------------------------------------------------------------------
	// Path resolution
	// -------------------------------------------------------------------------

	private get currentPath(): string {
		const top = this.stack[this.stack.length - 1];
		if (!top) return this.root;
		if (top.type === 1 /* array */) {
			return top.index < 0 ? top.basePath : `${top.basePath}[${top.index}]`;
		}
		return top.basePath;
	}

	// -------------------------------------------------------------------------
	// Stack manipulation
	// -------------------------------------------------------------------------

	private pushContainer(name: string, type: 0 | 1): void {
		const parent = this.stack[this.stack.length - 1];
		let basePath: string;

		if (!parent) {
			basePath = this.root ? this.root : name;
		} else if (parent.type === 1 /* array */) {
			const elementPath = this.currentPath;
			basePath = name ? `${elementPath}.${name}` : elementPath;
		} else {
			basePath = name
				? parent.basePath
					? `${parent.basePath}.${name}`
					: name
				: parent.basePath;
		}

		this.stack.push({ type, basePath, index: -1, value: type === 1 ? [] : {} });
	}

	private pushKey(key: string): void {
		const parent = this.stack[this.stack.length - 1];
		const base = parent?.basePath ?? this.root;
		const path = base ? `${base}.${key}` : key;
		this.stack.push({ type: 0, basePath: path, index: -1, value: undefined });
	}

	private popStack(): void {
		const top = this.stack[this.stack.length - 1];
		if (!top) return;

		const completingPath =
			top.type === 1 /* array */ ? top.basePath : this.currentPath;

		if (this.completions) {
			this.emit("patch", {
				path: completingPath,
				value: this.snapshot(top.value),
				op: "complete",
			} as StreamingChunk);
		}

		this.stack.pop();

		// Propagate completed value up to parent entry
		const parent = this.stack[this.stack.length - 1];
		if (parent) {
			if (parent.type === 1 /* array */) {
				// Write at the current index rather than pushing — index is already tracked
				const idx =
					top.type === 1
						? top.index // closing a nested array
						: parent.index; // closing an object element — parent has the current index
				if (idx >= 0) {
					(parent.value as unknown[])[idx] = top.value;
				}
			} else {
				// Object parent — extract key from path difference
				const key = top.basePath.slice(
					parent.basePath ? parent.basePath.length + 1 : 0,
				);
				(parent.value as Record<string, unknown>)[key] = top.value;
			}
		}
	}

	private popKey(): void {
		const top = this.stack[this.stack.length - 1];
		if (!top || top.type !== 0) return;

		if (this.completions) {
			this.emit("patch", {
				path: this.currentPath,
				value: this.snapshot(top.value),
				op: "complete",
			} as StreamingChunk);
		}

		this.stack.pop();

		// Propagate completed primitive value up to parent object entry
		const parent = this.stack[this.stack.length - 1];
		if (parent && parent.type === 0 /* object */) {
			const key = top.basePath.slice(
				parent.basePath ? parent.basePath.length + 1 : 0,
			);
			(parent.value as Record<string, unknown>)[key] = top.value;
		}
	}

	private incrementArrayIndex(): void {
		const top = this.stack[this.stack.length - 1];
		if (!top || top.type !== 1) return;
		top.index = top.index < 0 ? 0 : top.index + 1;
	}

	// -------------------------------------------------------------------------
	// Patch emission
	// -------------------------------------------------------------------------

	/**
	 * Deep-clone a value for safe delivery in complete patches.
	 * The stack entry's value is the same object reference as what the Collector
	 * stores — cloning at completion time ensures the patch carries a stable
	 * snapshot, not a live reference that subsequent patches would mutate.
	 */
	private snapshot(value: unknown): unknown {
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) return value.map((item) => this.snapshot(item));
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(value as object)) {
			copy[key] = this.snapshot((value as Record<string, unknown>)[key]);
		}
		return copy;
	}

	private patch(chunk: Omit<StreamingChunk, "path">): void {
		const top = this.stack[this.stack.length - 1];

		// Keep the current stack entry's value in sync — mirrors Collector applyPatch
		if (top) {
			if (chunk.op === "add") {
				top.value = chunk.value;
			} else if (chunk.op === "append") {
				top.value = ((top.value as string) ?? "") + (chunk.value as string);
			}
			// insert is handled by popStack propagation — array elements complete before parent
		}

		// For container add patches ({} or []), emit a fresh empty container rather
		// than the live stack entry reference. The stack entry accumulates the real
		// value internally; the Collector builds its own copy from subsequent patches.
		let emitValue = chunk.value;
		if (
			chunk.op === "add" &&
			typeof chunk.value === "object" &&
			chunk.value !== null
		) {
			emitValue = Array.isArray(chunk.value) ? [] : {};
		}

		this.emit("patch", {
			path: this.currentPath,
			value: emitValue,
			op: chunk.op,
		} as StreamingChunk);
	}

	// -------------------------------------------------------------------------
	// Core processing loop — offset-based buffer scan
	// -------------------------------------------------------------------------

	private process(): void {
		const buf = this.buf;
		const len = buf.length;

		while (this.pos < len) {
			switch (this.state) {
				case State.STRING_VALUE:
					this.scanStringValue(buf, len);
					break;

				case State.OBJECT_KEY_STRING:
					this.scanKeyString(buf, len);
					break;

				case State.UNICODE_ESCAPE:
					// Continuation of a \uXXXX sequence split across token boundaries.
					// processUnicodeEscape owns pos advancement — do not call stepCharCode
					// or the outer pos++ or we'll loop / skip characters.
					this.state = State.STRING_VALUE;
					this.processUnicodeEscape(buf, len);
					// If still not enough hex digits, state is back to UNICODE_ESCAPE;
					// loop will exit naturally when pos >= len.
					break;

				default:
					this.stepCharCode(buf.charCodeAt(this.pos));
					this.pos++;
					break;
			}
		}
	}

	/**
	 * Fast scan for STRING_VALUE.
	 *
	 * Advances pos as far as possible within the current token, emitting one
	 * patch per contiguous run of plain characters (no backslash, no quote).
	 * This is the most frequent code path for LLM output — long string values
	 * arrive as multiple write() calls and we want to emit one patch per call,
	 * not one per character.
	 */
	private scanStringValue(buf: string, len: number): void {
		// If a backslash arrived at the end of the previous token, the first
		// character of this token is the escape char — process it now.
		if (this.pendingEscape) {
			this.pendingEscape = false;
			this.processEscape(buf, len);
			if (this.state !== State.STRING_VALUE) return;
		}

		// Iterative loop — no recursion to avoid stack overflow on deeply escaped
		// strings that span many token boundaries.
		while (this.pos < len && this.state === State.STRING_VALUE) {
			const segStart = this.pos;

			// Scan forward to next quote or backslash
			while (this.pos < len) {
				const cc = buf.charCodeAt(this.pos);
				if (cc === CC_QUOTE || cc === CC_BACKSLASH) break;
				this.pos++;
			}

			// Emit any plain characters we just scanned past
			if (this.pos > segStart) {
				this.emitStringChunk(buf.slice(segStart, this.pos));
			}

			if (this.pos >= len) break; // end of token — wait for next write()

			const cc = buf.charCodeAt(this.pos);

			if (cc === CC_QUOTE) {
				this.pos++;
				if (!this.stringInitialised) {
					this.patch({ value: "", op: "add" });
				}
				this.popKey();
				this.state = State.AFTER_VALUE;
				return;
			}

			if (cc === CC_BACKSLASH) {
				this.pos++; // consume backslash
				if (this.pos >= len) {
					// Backslash at end of token — set flag and wait for escape char
					this.pendingEscape = true;
					break;
				}
				this.processEscape(buf, len);
				// Continue the outer while loop from new pos.
			}
		}
	}

	/**
	 * Fast scan for OBJECT_KEY_STRING — same idea as scanStringValue but
	 * accumulates into keyBuf without emitting patches.
	 */
	private scanKeyString(buf: string, len: number): void {
		const start = this.pos;

		while (this.pos < len) {
			const cc = buf.charCodeAt(this.pos);

			if (cc === CC_QUOTE) {
				this.keyBuf += buf.slice(start, this.pos);
				this.pos++;
				this.state = State.AFTER_KEY;
				return;
			}

			if (cc === CC_BACKSLASH) {
				this.keyBuf += buf.slice(start, this.pos);
				this.pos++; // consume backslash
				this.processEscapeIntoKeyBuf(buf, len);
				if (this.state === State.OBJECT_KEY_STRING) {
					this.scanKeyString(buf, len);
				}
				return;
			}

			this.pos++;
		}

		// Partial key — accumulate and wait for next write()
		this.keyBuf += buf.slice(start, this.pos);
	}

	/**
	 * Process a single escape sequence starting at pos (backslash already consumed).
	 * Handles \uXXXX including surrogate pairs.
	 * Advances pos past the escape.
	 */
	private processEscape(buf: string, len: number): void {
		if (this.pos >= len) {
			// scanStringValue sets pendingEscape before calling us — nothing to do.
			return;
		}

		const next = buf.charCodeAt(this.pos);
		this.pos++;

		if (next === CC_u) {
			this.processUnicodeEscape(buf, len);
			return;
		}

		let resolved: string;
		switch (next) {
			case CC_n:
				resolved = "\n";
				break;
			case CC_t:
				resolved = "\t";
				break;
			case CC_r:
				resolved = "\r";
				break;
			case CC_b:
				resolved = "\b";
				break;
			case CC_f:
				resolved = "\f";
				break;
			case CC_BACKSLASH:
				resolved = "\\";
				break;
			case CC_QUOTE:
				resolved = '"';
				break;
			case CC_SLASH_FWD:
				resolved = "/";
				break;
			default:
				resolved = String.fromCharCode(next);
				break;
		}

		this.emitStringChunk(resolved);
	}

	/**
	 * Process a \uXXXX escape, including surrogate pairs.
	 * Handles the case where 4 hex digits span token boundaries by accumulating
	 * into unicodeBuf.
	 */
	private processUnicodeEscape(buf: string, len: number): void {
		// How many hex digits do we still need?
		const needed = 4 - this.unicodeBuf.length;
		const available = len - this.pos;

		if (available < needed) {
			// Not enough digits in this token — accumulate and wait
			this.unicodeBuf += buf.slice(this.pos, len);
			this.pos = len;
			// Back up so the next write() knows we're mid-\uXXXX.
			// We use State.UNICODE_ESCAPE to signal this.
			this.state = State.UNICODE_ESCAPE;
			return;
		}

		this.unicodeBuf += buf.slice(this.pos, this.pos + needed);
		this.pos += needed;

		const code = parseInt(this.unicodeBuf, 16);
		this.unicodeBuf = "";

		// Surrogate pair handling
		if (code >= 0xd800 && code <= 0xdbff) {
			// High surrogate — hold it and expect \uXXXX immediately after
			this.highSurrogate = code;
			return;
		}

		if (code >= 0xdc00 && code <= 0xdfff && this.highSurrogate !== 0) {
			// Low surrogate — combine with held high surrogate
			const combined = String.fromCharCode(this.highSurrogate, code);
			this.highSurrogate = 0;
			this.emitStringChunk(combined);
			return;
		}

		if (this.highSurrogate !== 0) {
			// Previous high surrogate without a matching low — emit as-is
			this.emitStringChunk(String.fromCharCode(this.highSurrogate));
			this.highSurrogate = 0;
		}

		this.emitStringChunk(String.fromCharCode(code));
	}

	/** Same as processEscape but accumulates into keyBuf */
	private processEscapeIntoKeyBuf(buf: string, len: number): void {
		if (this.pos >= len) {
			this.pos--;
			return;
		}

		const next = buf.charCodeAt(this.pos);
		this.pos++;

		if (next === CC_u) {
			if (this.pos + 4 > len) {
				// Partial \uXXXX in key — rare, carry forward
				this.keyBuf += buf.slice(this.pos - 2); // '\u' + partial
				this.pos = len;
				return;
			}
			const hex = buf.slice(this.pos, this.pos + 4);
			this.pos += 4;
			this.keyBuf += String.fromCharCode(parseInt(hex, 16));
			return;
		}

		switch (next) {
			case CC_n:
				this.keyBuf += "\n";
				break;
			case CC_t:
				this.keyBuf += "\t";
				break;
			case CC_r:
				this.keyBuf += "\r";
				break;
			case CC_b:
				this.keyBuf += "\b";
				break;
			case CC_f:
				this.keyBuf += "\f";
				break;
			case CC_BACKSLASH:
				this.keyBuf += "\\";
				break;
			case CC_QUOTE:
				this.keyBuf += '"';
				break;
			case CC_SLASH_FWD:
				this.keyBuf += "/";
				break;
			default:
				this.keyBuf += String.fromCharCode(next);
				break;
		}
	}

	private emitStringChunk(chunk: string): void {
		if (!this.stringInitialised) {
			this.patch({ value: chunk, op: "add" });
			this.stringInitialised = true;
		} else {
			this.patch({ value: chunk, op: "append" });
		}
	}

	// -------------------------------------------------------------------------
	// Non-string character dispatch — called for all states except STRING_VALUE
	// and OBJECT_KEY_STRING which are handled by the fast scan paths above.
	// -------------------------------------------------------------------------

	private stepCharCode(cc: number): void {
		switch (this.state) {
			// ── START ──────────────────────────────────────────────────────────────
			case State.START: {
				if (cc === CC_LBRACE) {
					this.pushContainer("", 0);
					if (this.root) this.patch({ value: {}, op: "add" });
					this.state = State.OBJECT_KEY;
				} else if (cc === CC_LBRACKET) {
					this.pushContainer("", 1);
					if (this.root) this.patch({ value: [], op: "add" });
					this.state = State.ARRAY_VALUE;
				}
				// else: whitespace / BOM before root container — ignore
				break;
			}

			// ── OBJECT_KEY ─────────────────────────────────────────────────────────
			case State.OBJECT_KEY: {
				if (cc === CC_QUOTE) {
					this.keyBuf = "";
					this.state = State.OBJECT_KEY_STRING;
				} else if (cc === CC_RBRACE) {
					this.popStack();
					this.state = State.AFTER_VALUE;
				}
				break;
			}

			// ── AFTER_KEY ──────────────────────────────────────────────────────────
			case State.AFTER_KEY: {
				if (cc === CC_COLON) this.state = State.OBJECT_VALUE;
				break;
			}

			// ── OBJECT_VALUE ───────────────────────────────────────────────────────
			case State.OBJECT_VALUE: {
				if (this.isWS(cc)) break;
				if (cc === CC_QUOTE) {
					this.pushKey(this.keyBuf);
					this.keyBuf = "";
					this.stringInitialised = false;
					this.state = State.STRING_VALUE;
				} else if (cc === CC_LBRACE) {
					this.pushContainer(this.keyBuf, 0);
					this.keyBuf = "";
					this.patch({ value: {}, op: "add" });
					this.state = State.OBJECT_KEY;
				} else if (cc === CC_LBRACKET) {
					this.pushContainer(this.keyBuf, 1);
					this.keyBuf = "";
					this.patch({ value: [], op: "add" });
					this.state = State.ARRAY_VALUE;
				} else if (cc === CC_t || cc === CC_f) {
					this.pushKey(this.keyBuf);
					this.keyBuf = "";
					this.valBuf = String.fromCharCode(cc);
					this.state = State.BOOLEAN_VALUE;
				} else if (cc === CC_n) {
					this.pushKey(this.keyBuf);
					this.keyBuf = "";
					this.valBuf = "n";
					this.state = State.NULL_VALUE;
				} else if (cc === CC_MINUS || (cc >= CC_0 && cc <= CC_9)) {
					this.pushKey(this.keyBuf);
					this.keyBuf = "";
					this.valBuf = String.fromCharCode(cc);
					this.state = State.NUMBER_VALUE;
				}
				break;
			}

			// ── NUMBER_VALUE ───────────────────────────────────────────────────────
			case State.NUMBER_VALUE: {
				if (
					(cc >= CC_0 && cc <= CC_9) ||
					cc === 0x2e || // '.'
					cc === 0x65 ||
					cc === 0x45 || // 'e' 'E'
					cc === 0x2b ||
					cc === CC_MINUS // '+' '-'
				) {
					this.valBuf += String.fromCharCode(cc);
				} else {
					this.emitNumber();
					this.popKey();
					this.state = State.AFTER_VALUE;
					this.stepCharCode(cc); // re-process terminator
				}
				break;
			}

			// ── BOOLEAN_VALUE ──────────────────────────────────────────────────────
			case State.BOOLEAN_VALUE: {
				this.valBuf += String.fromCharCode(cc);
				if (this.valBuf === "true") {
					this.patch({ value: true, op: "add" });
					this.popKey();
					this.valBuf = "";
					this.state = State.AFTER_VALUE;
				} else if (this.valBuf === "false") {
					this.patch({ value: false, op: "add" });
					this.popKey();
					this.valBuf = "";
					this.state = State.AFTER_VALUE;
				}
				break;
			}

			// ── NULL_VALUE ─────────────────────────────────────────────────────────
			case State.NULL_VALUE: {
				this.valBuf += String.fromCharCode(cc);
				if (this.valBuf === "null") {
					this.patch({ value: null, op: "add" });
					this.popKey();
					this.valBuf = "";
					this.state = State.AFTER_VALUE;
				}
				break;
			}

			// ── ARRAY_VALUE ────────────────────────────────────────────────────────
			case State.ARRAY_VALUE: {
				if (this.isWS(cc) || cc === CC_COMMA) break;

				if (cc === CC_RBRACKET) {
					this.popStack();
					this.state = State.AFTER_VALUE;
					break;
				}

				this.incrementArrayIndex();

				if (cc === CC_QUOTE) {
					this.stringInitialised = false;
					this.state = State.STRING_VALUE;
				} else if (cc === CC_LBRACE) {
					this.pushContainer("", 0);
					this.patch({ value: {}, op: "add" });
					this.state = State.OBJECT_KEY;
				} else if (cc === CC_LBRACKET) {
					this.pushContainer("", 1);
					this.patch({ value: [], op: "add" });
					this.state = State.ARRAY_VALUE;
				} else if (cc === CC_t || cc === CC_f) {
					this.valBuf = String.fromCharCode(cc);
					this.state = State.BOOLEAN_VALUE;
				} else if (cc === CC_n) {
					this.valBuf = "n";
					this.state = State.NULL_VALUE;
				} else if (cc === CC_MINUS || (cc >= CC_0 && cc <= CC_9)) {
					this.valBuf = String.fromCharCode(cc);
					this.state = State.NUMBER_VALUE;
				}
				break;
			}

			// ── AFTER_VALUE ────────────────────────────────────────────────────────
			case State.AFTER_VALUE: {
				if (this.isWS(cc)) break;
				if (cc === CC_COMMA) {
					const top = this.stack[this.stack.length - 1];
					this.state = top?.type === 1 ? State.ARRAY_VALUE : State.OBJECT_KEY;
				} else if (cc === CC_RBRACE || cc === CC_RBRACKET) {
					this.popStack();
				}
				break;
			}
		}
	}

	// -------------------------------------------------------------------------
	// Finalise — flush pending primitives at end of stream
	// -------------------------------------------------------------------------

	private finalise(): void {
		switch (this.state) {
			case State.NUMBER_VALUE:
				this.emitNumber();
				this.popKey();
				break;
			case State.BOOLEAN_VALUE:
				if (this.valBuf === "true") this.patch({ value: true, op: "add" });
				else if (this.valBuf === "false")
					this.patch({ value: false, op: "add" });
				this.popKey();
				this.valBuf = "";
				break;
			case State.NULL_VALUE:
				if (this.valBuf === "null") this.patch({ value: null, op: "add" });
				this.popKey();
				this.valBuf = "";
				break;
			default:
				break;
		}
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private emitNumber(): void {
		const raw = this.valBuf;
		const lower = raw.toLowerCase();
		const value =
			lower.includes(".") || lower.includes("e")
				? parseFloat(raw)
				: parseInt(raw, 10);

		if (Number.isNaN(value)) {
			this.emit("error", new JsonPulseError(`Invalid number: "${raw}"`));
			this.valBuf = "";
			return;
		}
		this.patch({ value, op: "add" });
		this.valBuf = "";
	}

	private isWS(cc: number): boolean {
		return cc === CC_SP || cc === CC_NL || cc === CC_CR || cc === CC_TAB;
	}
}
