/**
 * Server-side configuration and safety limits.
 *
 * Everything here is read from the environment exactly once, at startup, so
 * that a tool call can never influence a limit. Credentials are read but
 * never re-exported in a readable form -- see `hasCredentials`.
 */

/** Parse a positive-number env var, falling back to a default. */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive number, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/** Parse a comma-separated allowlist. An unset or empty var means "no allowlist". */
function allowlistFromEnv(name: string): Set<string> | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;

  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  return symbols.length > 0 ? new Set(symbols) : null;
}

export interface Config {
  /**
   * When true, orders are validated and priced but never sent to Groww.
   * Defaults to true. Only the exact string "true" flips it off.
   */
  dryRun: boolean;
  maxQuantityPerOrder: number;
  maxOrderValueInr: number;
  /** null means every symbol matching the format regex is permitted. */
  symbolAllowlist: Set<string> | null;
  /** Whether both credential vars are present -- never the values themselves. */
  hasCredentials: boolean;
}

export function loadConfig(): Config {
  return {
    // Fail closed: anything other than a literal "true" keeps DRY_RUN on.
    dryRun: process.env.GROWW_LIVE_TRADING?.trim().toLowerCase() !== "true",
    maxQuantityPerOrder: numberFromEnv("MAX_QUANTITY_PER_ORDER", 10),
    maxOrderValueInr: numberFromEnv("MAX_ORDER_VALUE_INR", 10_000),
    symbolAllowlist: allowlistFromEnv("SYMBOL_ALLOWLIST"),
    hasCredentials: Boolean(
      process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET,
    ),
  };
}
