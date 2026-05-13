/**
 * The two failure classes this server distinguishes.
 *
 * ValidationError  -- the request was wrong. Detected before any network call,
 *                     costs nothing, and the message tells the model what to fix.
 * ExecutionError   -- the request was well-formed but the world said no
 *                     (funds, market hours, exchange rejection, API failure).
 *
 * Both are returned as tool results marked isError. Neither is ever thrown out
 * of a handler, because an uncaught throw takes the whole server down.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ExecutionError extends Error {
  constructor(
    message: string,
    /** True when the same call could plausibly succeed later. */
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}
