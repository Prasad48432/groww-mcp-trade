/**
 * stdout carries the JSON-RPC stream. Every diagnostic must go to stderr or
 * the transport breaks -- so this module is the only sanctioned way to log,
 * and nothing in this server may call console.log.
 */

function emit(level: string, message: string, detail?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  process.stderr.write(detail === undefined ? `${line}\n` : `${line} ${safe(detail)}\n`);
}

/** Stringify without throwing on cycles or BigInt. */
function safe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message: string, detail?: unknown) => emit("info", message, detail),
  warn: (message: string, detail?: unknown) => emit("warn", message, detail),
  error: (message: string, detail?: unknown) => emit("error", message, detail),
};
