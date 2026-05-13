#!/usr/bin/env bun
/**
 * Entry point. Loads config, refuses obviously unsafe startups, and connects
 * the server over stdio.
 *
 * Nothing here may write to stdout -- stdout is the JSON-RPC stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Refuse to start live without credentials rather than failing per-call:
  // in that state the value cap cannot be enforced, so no order is safe.
  if (!config.dryRun && !config.hasCredentials) {
    log.error(
      "GROWW_LIVE_TRADING=true but GROWW_API_KEY / GROWW_API_SECRET are not set. Refusing to start.",
    );
    process.exit(1);
  }

  if (config.dryRun) {
    log.info("DRY RUN mode -- orders are validated and priced but never sent to Groww.");
    log.info("Set GROWW_LIVE_TRADING=true to place real orders.");
    if (!config.hasCredentials) {
      log.warn(
        "No Groww credentials found: live prices are unavailable, so order value cannot be estimated.",
      );
    }
  } else {
    log.warn("LIVE TRADING ENABLED -- tool calls will place real orders with real money.");
  }

  log.info("Safety limits", {
    maxQuantityPerOrder: config.maxQuantityPerOrder,
    maxOrderValueInr: config.maxOrderValueInr,
    symbolAllowlist: config.symbolAllowlist ? [...config.symbolAllowlist] : "disabled (all symbols)",
  });

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  log.info("groww-trade-mcp ready on stdio");
}

// A rejected promise or uncaught throw must not leave a half-dead process
// holding the transport open: log the cause, then exit non-zero so the client
// sees a clean disconnect and can restart.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", error.stack);
  process.exit(1);
});

main().catch((error) => {
  log.error("Fatal startup error", error instanceof Error ? error.message : error);
  process.exit(1);
});
