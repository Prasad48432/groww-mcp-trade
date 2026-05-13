/**
 * MCP server wiring: build the server, register every tool in the registry,
 * and normalise results and failures.
 *
 * The invariant this file exists to hold: a tool handler may fail in any way
 * at all and the server keeps running. A thrown error inside a handler becomes
 * an error-flagged tool result, never a crashed process and never an empty
 * success.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { ExecutionError, ValidationError } from "./errors.js";
import { log } from "./logger.js";
import { tools } from "./tools/index.js";
import type { ToolOutput } from "./tools/types.js";

/** MCP result shape. Kept local so tool code stays free of protocol types. */
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function success(output: ToolOutput): ToolResult {
  const blocks = [{ type: "text" as const, text: output.summary }];
  if (output.data) {
    blocks.push({ type: "text" as const, text: JSON.stringify(output.data, null, 2) });
  }
  return { content: blocks };
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Turn any thrown value into an error result.
 *
 * The final branch matters most: an unexpected error's message may contain a
 * stack frame, a filesystem path, or a raw API body, so it is logged to stderr
 * and replaced with a fixed string rather than forwarded.
 */
function toErrorResult(toolName: string, error: unknown): ToolResult {
  if (error instanceof ValidationError) {
    return failure(`Invalid request -- nothing was sent to Groww.\n\n${error.message}`);
  }

  if (error instanceof ExecutionError) {
    return failure(
      `Order execution failed.\n\n${error.message}\n\n` +
        (error.retryable
          ? "This may succeed if retried later. Do not retry immediately in a loop."
          : "Retrying with the same input will not help. Report this to the user rather than retrying."),
    );
  }

  log.error(`Unhandled error in ${toolName}`, error instanceof Error ? error.stack : error);
  return failure(
    `The ${toolName} tool failed unexpectedly. The order was most likely NOT placed, ` +
      `but this is not guaranteed -- verify in the Groww app before retrying, or you risk a duplicate order. ` +
      `Details are in the server logs (stderr).`,
  );
}

export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "groww-trade-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: config.dryRun
        ? `Groww equity order tools (NSE, CASH, CNC delivery), running in DRY RUN mode.\n` +
          `Nothing here places a real order or spends money: calls are validated and priced against the\n` +
          `live market, then the payload that WOULD have been sent is returned. No request reaches the\n` +
          `broker. These tools are safe to call when the user asks to buy or sell -- doing so shows them\n` +
          `exactly what the trade would look like. Always report results as a simulation and never state\n` +
          `that a real trade was placed.`
        : `Places real equity orders on a live Groww brokerage account (NSE, CASH, CNC delivery).\n` +
          `Orders are MARKET orders and fill at the prevailing market price.\n` +
          `LIVE TRADING IS ENABLED: every buy_stock or sell_stock call spends real money and cannot be\n` +
          `undone. The user enabled this deliberately. Confirm symbol, side and quantity before each call.`,
    },
  );

  for (const tool of tools) {
    const name = tool.name(config);

    server.registerTool(
      name,
      {
        title: tool.title(config),
        description: tool.description(config),
        inputSchema: tool.inputSchema,
        annotations: tool.annotations?.(config),
      },
      async (args: unknown): Promise<ToolResult> => {
        try {
          return success(await tool.handler(args, config));
        } catch (error) {
          return toErrorResult(name, error);
        }
      },
    );
  }

  log.info(`Registered ${tools.length} tools`, tools.map((t) => t.name(config)));
  return server;
}
