/**
 * Thin wrapper over the growwapi SDK.
 *
 * Two jobs beyond delegation:
 *  1. Lazy client construction. `new GrowwAPI()` calls validateEnvVariables()
 *     and throws when credentials are missing, so constructing at import time
 *     would kill the server on startup -- including in DRY_RUN, where no
 *     credentials are needed to be useful.
 *  2. Error sanitisation. The SDK's HttpClient rejects with
 *     `new Error(await res.text())`, i.e. the raw Groww response body, which
 *     can carry account identifiers. Nothing raw may reach a tool result.
 */

import {
  GrowwAPI,
  Segment,
  type CreateOrderParams,
  type CreateOrderResponse,
} from "growwapi";
import { log } from "./logger.js";
import { ExecutionError } from "./errors.js";

let client: GrowwAPI | null = null;

/** Construct on first use; the SDK reads GROWW_API_KEY/SECRET from env itself. */
function getClient(): GrowwAPI {
  if (client === null) client = new GrowwAPI();
  return client;
}

/**
 * Map an unknown thrown value to a message safe to return to the model.
 *
 * Deliberately allowlist-based: we match known failure shapes and emit our own
 * wording. Anything unrecognised becomes a generic message, because the raw
 * text may embed account or order identifiers. The full error goes to stderr.
 */
export function sanitizeError(error: unknown, context: string): ExecutionError {
  log.error(`${context} failed`, error instanceof Error ? error.message : error);

  const raw = (error instanceof Error ? error.message : String(error)).toLowerCase();

  const patterns: Array<[RegExp, string, boolean]> = [
    [/insufficient|not enough|margin|balance/, "Insufficient funds or margin to place this order.", false],
    [/market.*clos|outside.*market|trading.*hours|session/, "The market is closed. Orders can be placed during market hours.", true],
    [/holding|quantity.*not.*available|short/, "Insufficient holdings to sell the requested quantity.", false],
    [/reject/, "The order was rejected by the exchange.", false],
    [/unauthor|forbidden|invalid.*token|401|403/, "Authentication with Groww failed. Check GROWW_API_KEY and GROWW_API_SECRET.", false],
    [/rate.?limit|too many requests|429/, "Rate limited by Groww. Wait before retrying.", true],
    [/timeout|etimedout|econnrefused|enotfound|network|fetch failed/, "Could not reach Groww. This is a network problem, not an order problem.", true],
    [/symbol|instrument|not found|404/, "Groww did not recognise this trading symbol on NSE.", false],
  ];

  for (const [pattern, message, retryable] of patterns) {
    if (pattern.test(raw)) return new ExecutionError(message, retryable);
  }

  return new ExecutionError(
    `${context} failed. See server logs (stderr) for details.`,
    false,
  );
}

/**
 * Last traded price for an NSE cash symbol, in INR.
 *
 * Used to estimate order value for the MAX_ORDER_VALUE_INR cap. The endpoint
 * keys its response by "<EXCHANGE>_<SYMBOL>".
 */
export async function getLastTradedPrice(tradingSymbol: string): Promise<number> {
  const key = `NSE_${tradingSymbol}`;

  let response: Record<string, number>;
  try {
    response = await getClient().liveData.getLTP({
      exchangeSymbols: [key],
      segment: Segment.CASH,
    });
  } catch (error) {
    throw sanitizeError(error, "Price lookup");
  }

  const price = response?.[key];
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new ExecutionError(
      `Groww returned no usable price for ${tradingSymbol} on NSE. The symbol may be invalid or not currently traded.`,
      false,
    );
  }
  return price;
}

/** Submit an order. Callers must have already enforced every safety limit. */
export async function createOrder(
  params: CreateOrderParams,
): Promise<CreateOrderResponse> {
  try {
    return await getClient().orders.create(params);
  } catch (error) {
    throw sanitizeError(error, "Order placement");
  }
}
