/**
 * Tool registry. Append here to expose a new tool -- server.ts needs no change.
 *
 * Obvious next additions: get_holdings (groww.holdings.list),
 * get_quote (groww.liveData.getQuote), cancel_order (groww.orders.cancel).
 * Read-only tools should set readOnlyHint: true and skip the safety caps,
 * which exist to bound spending and are meaningless for a query.
 */

import type { ToolDefinition } from "./types.js";
import { buyStockTool, sellStockTool } from "./trade.js";

export const tools: ToolDefinition<any>[] = [buyStockTool, sellStockTool];

export type { ToolDefinition, ToolOutput } from "./types.js";
