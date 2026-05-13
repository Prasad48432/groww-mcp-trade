/**
 * buy_stock and sell_stock.
 *
 * Both are the same pipeline with a different TransactionType, so the pipeline
 * lives in `placeOrder` and the two exported definitions are thin wrappers.
 *
 * Order of operations is deliberate and must not be rearranged: every check
 * that can reject without spending money runs before the one network call
 * that can.
 */

import { z } from "zod";
import {
  Exchange,
  OrderType,
  Product,
  Segment,
  TransactionType,
  Validity,
  type CreateOrderParams,
} from "growwapi";
import type { Config } from "../config.js";
import { ExecutionError, ValidationError } from "../errors.js";
import { createOrder, getLastTradedPrice } from "../groww.js";
import { log } from "../logger.js";
import type { ToolDefinition, ToolOutput } from "./types.js";

/**
 * NSE cash-segment trading symbols are uppercase alphanumerics, occasionally
 * with a trailing marker (e.g. IDEA, M&M is excluded deliberately -- ampersand
 * symbols must be added consciously rather than by loosening the regex).
 */
const TRADING_SYMBOL = /^[A-Z0-9]{1,20}$/;

const inputSchema = {
  tradingSymbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      TRADING_SYMBOL,
      "tradingSymbol must be 1-20 uppercase letters/digits, e.g. HDFCBANK, RELIANCE, SBIN.",
    )
    .describe(
      "NSE trading symbol in uppercase, e.g. HDFCBANK, RELIANCE, SBIN. Not the company name.",
    ),
  quantity: z
    .number()
    .int("quantity must be a whole number of shares.")
    .positive("quantity must be greater than zero.")
    .describe("Number of shares. Whole shares only; fractional is not supported."),
};

/** Everything the caller does not get to choose. */
const ORDER_DEFAULTS = {
  exchange: Exchange.NSE,
  segment: Segment.CASH,
  product: Product.CNC,
  validity: Validity.Day,
  orderType: OrderType.Market,
} as const;

/**
 * 16-char alphanumeric reference, within Groww's 8-20 window.
 *
 * Time-ordered prefix plus randomness: the prefix makes duplicates visible when
 * scanning order history, and the suffix keeps two calls in the same
 * millisecond distinct. A retried call gets a NEW id on purpose -- the id makes
 * a duplicate submission detectable after the fact, it does not suppress one.
 */
function generateOrderReferenceId(): string {
  const timePart = Date.now().toString(36).toUpperCase().padStart(9, "0").slice(-9);
  const randomPart = Math.random().toString(36).toUpperCase().slice(2, 9).padEnd(7, "0");
  return `${timePart}${randomPart}`.slice(0, 16);
}

/** Round to paise; float multiplication of price x quantity drifts otherwise. */
function toInr(value: number): number {
  return Math.round(value * 100) / 100;
}

async function placeOrder(
  args: { tradingSymbol: string; quantity: number },
  config: Config,
  transactionType: TransactionType,
): Promise<ToolOutput> {
  const { tradingSymbol, quantity } = args;
  const side = transactionType === TransactionType.Buy ? "BUY" : "SELL";

  // --- Checks that cost nothing. All of these run before any network call. ---

  if (config.symbolAllowlist && !config.symbolAllowlist.has(tradingSymbol)) {
    throw new ValidationError(
      `${tradingSymbol} is not on this server's SYMBOL_ALLOWLIST. ` +
        `Permitted symbols: ${[...config.symbolAllowlist].sort().join(", ")}. ` +
        `This limit is set by the server operator and cannot be overridden from a tool call.`,
    );
  }

  if (quantity > config.maxQuantityPerOrder) {
    throw new ValidationError(
      `quantity ${quantity} exceeds MAX_QUANTITY_PER_ORDER (${config.maxQuantityPerOrder}). ` +
        `Reduce the quantity to ${config.maxQuantityPerOrder} or fewer shares. ` +
        `Do not work around this by splitting the order across multiple calls.`,
    );
  }

  // --- Pricing. Needed to enforce the value cap, so it precedes the order. ---

  let lastTradedPrice: number | null = null;
  let estimatedValueInr: number | null = null;
  let priceNote: string | null = null;

  if (config.hasCredentials) {
    try {
      lastTradedPrice = await getLastTradedPrice(tradingSymbol);
    } catch (error) {
      // In DRY RUN the point is to show the payload, so a price failure is
      // reported rather than fatal -- otherwise an unreachable or
      // misconfigured API makes the whole rehearsal impossible. In LIVE it
      // stays fatal: without a price the value cap cannot be enforced.
      if (!config.dryRun) throw error;
      priceNote =
        error instanceof Error ? error.message : "Price lookup failed for an unknown reason.";
      log.warn("DRY_RUN price lookup failed; continuing without a value estimate", {
        tradingSymbol,
      });
    }
  }

  if (lastTradedPrice !== null) {
    estimatedValueInr = toInr(lastTradedPrice * quantity);

    if (estimatedValueInr > config.maxOrderValueInr) {
      const affordable = Math.floor(config.maxOrderValueInr / lastTradedPrice);
      throw new ValidationError(
        `Estimated order value INR ${estimatedValueInr} (${quantity} x INR ${lastTradedPrice}) ` +
          `exceeds MAX_ORDER_VALUE_INR (${config.maxOrderValueInr}). ` +
          (affordable > 0
            ? `At the current price, at most ${affordable} share(s) fit within the cap.`
            : `Even a single share exceeds the cap at the current price.`),
      );
    }
  } else if (!config.dryRun) {
    // Unreachable in practice -- server.ts refuses to enable live trading
    // without credentials -- but the cap must never be silently skipped.
    throw new ExecutionError(
      "Live trading is enabled but Groww credentials are missing, so the order value cap cannot be enforced. Refusing to place the order.",
      false,
    );
  }

  // --- Payload. Identical in both modes; that is what makes DRY_RUN useful. ---

  const orderReferenceId = generateOrderReferenceId();
  const payload: CreateOrderParams = {
    ...ORDER_DEFAULTS,
    tradingSymbol,
    quantity,
    transactionType,
    orderReferenceId,
    // price is intentionally omitted: a MARKET order carries no limit price.
  };

  const summaryLines = [
    `${side} ${quantity} x ${tradingSymbol}`,
    `Order type: MARKET (fills at the prevailing market price, not a price you chose)`,
    `Exchange/segment/product: NSE / CASH / CNC (delivery), validity DAY`,
    lastTradedPrice !== null
      ? `Last traded price: INR ${lastTradedPrice} -> estimated value INR ${estimatedValueInr}`
      : `Price UNAVAILABLE, so the MAX_ORDER_VALUE_INR cap could not be checked. ` +
        (priceNote ?? "No Groww credentials are configured."),
    `Order reference ID: ${orderReferenceId}`,
  ];

  if (config.dryRun) {
    log.info("DRY_RUN order simulated", { side, tradingSymbol, quantity, orderReferenceId });
    return {
      summary: [
        `DRY RUN -- no order was placed and no money moved.`,
        ``,
        ...summaryLines,
        ``,
        `This is exactly what would be sent to Groww. To place it for real, the`,
        `server operator must restart this server with GROWW_LIVE_TRADING=true.`,
        `You cannot enable live trading from a tool call.`,
      ].join("\n"),
      data: {
        mode: "DRY_RUN",
        placed: false,
        valueCapChecked: lastTradedPrice !== null,
        order: { ...payload, side, lastTradedPrice, estimatedValueInr },
      },
    };
  }

  // --- Live. Past this line, real money is committed. ---

  log.warn("LIVE order submitting", { side, tradingSymbol, quantity, orderReferenceId });
  const response = await createOrder(payload);
  log.warn("LIVE order accepted", { orderReferenceId, status: response.orderStatus });

  return {
    summary: [
      `LIVE ORDER PLACED -- real money, real brokerage account.`,
      ``,
      ...summaryLines,
      `Groww order ID: ${response.growwOrderId}`,
      `Status: ${response.orderStatus}${response.remark ? ` (${response.remark})` : ""}`,
      ``,
      `A status of NEW or ACKED means accepted, not filled. Confirm the fill in`,
      `the Groww app before treating the position as open.`,
    ].join("\n"),
    data: {
      mode: "LIVE",
      placed: true,
      order: { ...payload, side, lastTradedPrice, estimatedValueInr },
      result: {
        growwOrderId: response.growwOrderId,
        orderReferenceId: response.orderReferenceId,
        orderStatus: response.orderStatus,
        remark: response.remark,
      },
    },
  };
}

/**
 * The tool description, which is the only thing the model has to reason with.
 *
 * It must describe the mode the server is actually in. Describing a DRY RUN
 * tool as spending real money is not "erring on the safe side" -- it is a
 * false statement that makes a harmless tool look dangerous, and a caller
 * acting correctly on that description will decline to use it at all.
 */
function describe(action: "Buy" | "Sell", config: Config): string {
  const verb = action.toUpperCase();

  const shared = [
    ``,
    `ORDER TYPE: MARKET. The order fills at whatever price the order book currently offers, which may be`,
    `worse than the last traded price -- materially worse for illiquid stocks or during volatile opens.`,
    `No limit price is set and no price protection applies.`,
    ``,
    `Fixed by the server and not selectable: NSE exchange, CASH segment, CNC (delivery) product, DAY validity.`,
    action === "Buy"
      ? `Bought shares settle into holdings.`
      : `Sells require the shares to already be in holdings; this cannot open a short position.`,
    ``,
    `The server enforces a maximum quantity per order, a maximum order value in INR, and optionally a symbol`,
    `allowlist. Exceeding a limit returns an error before anything is sent. Do not attempt to evade a limit by`,
    `splitting one intended trade across several calls.`,
  ];

  if (config.dryRun) {
    return [
      `SIMULATION ONLY -- this tool does NOT place an order and does NOT spend money.`,
      ``,
      `The server is running in DRY RUN mode. This tool validates a hypothetical ${verb} order, prices it`,
      `against the live market, and returns the exact payload that WOULD be sent to the broker. No request`,
      `reaches Groww, no funds move, and nothing about the user's account changes. It is a dry-run preview,`,
      `equivalent to a paper trade, and it is safe to call whenever the user asks to buy or sell.`,
      ``,
      `Live trading is disabled by a server-side environment variable that cannot be changed from a tool`,
      `call, so this tool cannot place a real order even if asked to. Describe results as a simulation and`,
      `never tell the user that a real trade was placed.`,
      ...shared,
      ``,
      `Confirm the symbol and quantity with the user before calling. If the user's intent is ambiguous, ask.`,
    ].join("\n");
  }

  return [
    `Place a REAL ${verb} order for Indian equities on a LIVE Groww brokerage account, using REAL MONEY.`,
    ``,
    `This is not a simulation, a paper trade, or a quote. Calling this tool spends or liquidates actual`,
    `funds in the user's account and the result cannot be undone by calling another tool -- an executed`,
    `order can only be reversed by placing an opposing trade at a new price.`,
    ``,
    `The user has deliberately enabled live trading on this server, so placing orders at their explicit`,
    `request is the intended purpose of this tool. Treat it like any other consequential action: confirm`,
    `the symbol, quantity and side with the user, and proceed once they have clearly asked for it.`,
    ...shared,
    ``,
    `If the user's intent is at all ambiguous, ask before calling rather than guessing.`,
  ].join("\n");
}

/**
 * In DRY RUN nothing leaves the process, so the tool really is read-only and
 * non-destructive. Claiming otherwise makes clients prompt for confirmation on
 * an action that changes nothing, which trains users to click through warnings
 * that matter.
 */
function annotationsFor(config: Config) {
  return config.dryRun
    ? {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true, // still reads live prices
      }
    : {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
}

/** Titles carry the mode too -- some clients show only the title. */
function titleFor(action: "Buy" | "Sell", config: Config): string {
  return config.dryRun ? `${action} stock (simulation)` : `${action} stock (REAL MONEY)`;
}

export const buyStockTool: ToolDefinition<typeof inputSchema> = {
  name: (config) => (config.dryRun ? "preview_buy_order" : "buy_stock"),
  title: (config) => titleFor("Buy", config),
  description: (config) => describe("Buy", config),
  inputSchema,
  annotations: annotationsFor,
  handler: (args, config) => placeOrder(args, config, TransactionType.Buy),
};

export const sellStockTool: ToolDefinition<typeof inputSchema> = {
  name: (config) => (config.dryRun ? "preview_sell_order" : "sell_stock"),
  title: (config) => titleFor("Sell", config),
  description: (config) => describe("Sell", config),
  inputSchema,
  annotations: annotationsFor,
  handler: (args, config) => placeOrder(args, config, TransactionType.Sell),
};
