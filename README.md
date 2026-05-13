# trade-mcp

An MCP server that lets a language model place real equity orders on a live [Groww](https://groww.in) brokerage account.

MCP (Model Context Protocol) is a standard that lets an AI client discover and call tools on an external server — here, that means letting Claude buy and sell stock.

**This spends real money.** It ships in DRY RUN mode and stays there until you deliberately turn it off.

---

## Install

```bash
bun install
cp .env.example .env      # then fill in your credentials
bun run smoke             # verify the handshake without touching the brokerage
```

| Script | Purpose |
| --- | --- |
| `bun run start` | Run the server on stdio |
| `bun run dev` | Same, with reload on change |
| `bun run build` | Bundle to `dist/index.js` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run smoke` | Drive the server with hand-written JSON-RPC |

---

## Tools

| Tool | Input | Effect |
| --- | --- | --- |
| `buy_stock` | `tradingSymbol` (e.g. `SBIN`), `quantity` (positive integer) | Places a **MARKET BUY** on NSE / CASH / CNC, DAY validity |
| `sell_stock` | same | Places a **MARKET SELL**, same defaults |

Only symbol and quantity are model-supplied. Exchange, segment, product, validity, and order type are server-side constants — the model cannot switch to intraday leverage, hop exchanges, or change the order type.

Both tools are annotated `destructiveHint: true` and `openWorldHint: true` so MCP clients prompt a human before invoking.

Adding a tool means writing one `ToolDefinition` and appending it to the array in [src/tools/index.ts](src/tools/index.ts) — `server.ts` iterates the registry and needs no edit. `get_holdings`, `get_quote`, and `cancel_order` are the obvious next ones; they map to `groww.holdings.list`, `groww.liveData.getQuote`, and `groww.orders.cancel`.

---

## DRY RUN → live

DRY RUN is the default and **fails closed**: only the exact string `true` disables it.

```bash
GROWW_LIVE_TRADING=true bun run start
```

In DRY RUN the server does everything except the final API call — validates input, checks every cap, fetches the live price, generates the reference ID, assembles the exact `CreateOrderParams` payload, and returns it. The payload is byte-identical to what live mode sends, which is what makes the rehearsal meaningful.

Two deliberate properties:

- **Live trading cannot be enabled from a tool call.** It is a process-level environment variable, so flipping it requires a human with shell access and a restart. Nothing the model emits can reach it.
- **The server refuses to start** with `GROWW_LIVE_TRADING=true` and no credentials, because in that state the order-value cap cannot be evaluated and no order would be safe.

---

## Safety limits

Every limit is read once at startup and enforced server-side, before the network call. A tool call cannot influence one.

| Variable | Default | Why it exists |
| --- | --- | --- |
| `GROWW_LIVE_TRADING` | `false` | The blast-radius switch. An LLM misfiring against a validator costs nothing; against a live account it costs money. Safe must be the state you get by doing nothing. |
| `MAX_QUANTITY_PER_ORDER` | `10` | Bounds a misparsed quantity — "buy a hundred rupees of SBIN" becoming `quantity: 100`. Unit confusion (shares vs rupees vs lots) is a characteristic LLM failure, and this catches it. |
| `MAX_ORDER_VALUE_INR` | `10000` | The real spending cap. Quantity alone doesn't bound cost: 10 shares is ₹8k of SBIN or ₹700k of MRF. Checked against `quantity × live LTP` before the order. |
| `SYMBOL_ALLOWLIST` | unset | Optional. Turns an open-ended "trade anything on NSE" capability into a closed set. Off by default because an empty allowlist that silently blocked everything would be worse than none. |

Limits are enforced cheapest-first: allowlist and quantity reject with zero network calls; the value cap costs one price lookup; only then is an order sent.

**Order reference IDs.** Every order carries a generated 16-character alphanumeric `orderReferenceId` (Groww accepts 8–20). It is timestamp-prefixed plus random, so duplicates stand out when scanning order history and two calls in the same millisecond stay distinct. Note what this does and does not do: a retried call gets a *new* ID, so the ID makes a duplicate submission **detectable after the fact** — it does not prevent one. Genuine idempotency would require a caller-supplied key, which the two-parameter tool contract doesn't have.

**Credentials** are read from the environment by the `growwapi` SDK itself and never enter a tool result, a log line, or an error message.

---

## Error handling

Two classes, distinguished because the model should react to them differently:

- **`ValidationError`** — bad symbol, non-integer quantity, cap exceeded. Caught before any network call. The message states what to fix and, where useful, the number that would fit (`"at most 3 share(s) fit within the cap"`).
- **`ExecutionError`** — insufficient funds, market closed, exchange rejection, network failure. Carries a `retryable` flag so the model is told whether waiting could help, rather than guessing.

Neither is ever thrown out of a handler; both become tool results with `isError: true`. An unexpected error is logged to stderr and replaced with a fixed message — the server keeps running and never returns an empty success.

This matters more than it looks: the SDK's HTTP client rejects with `new Error(await res.text())`, i.e. the **raw Groww response body**, which can carry account identifiers. [src/groww.ts](src/groww.ts) matches known failure shapes against an allowlist of patterns and emits its own wording; anything unrecognised becomes a generic message. Raw API text never reaches the model.

All logging goes to **stderr**. stdout carries the JSON-RPC stream, and a single `console.log` would corrupt it — so [src/logger.ts](src/logger.ts) is the only sanctioned way to log, and the smoke test fails loudly on any non-JSON byte appearing on stdout.

---

## Claude Desktop

Build first (`bun run build`), then add to `claude_desktop_config.json`:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "groww-trade": {
      "command": "C:\\Program Files\\nodejs\\node_modules\\bun\\bin\\bun.exe",
      "args": ["run", "E:\\trade-mcp\\dist\\index.js"],
      "env": {
        "GROWW_API_KEY": "your_api_key_here",
        "GROWW_API_SECRET": "your_api_secret_here",
        "GROWW_LIVE_TRADING": "false",
        "MAX_QUANTITY_PER_ORDER": "10",
        "MAX_ORDER_VALUE_INR": "10000"
      }
    }
  }
}
```

Three things that will otherwise bite you:

- **Set the variables in the `env` block**, not `.env`. Claude Desktop launches the server with its own working directory, so a `.env` next to the source will not reliably be found.
- **Use the absolute path to `bun.exe`**, not `"bun"`. On Windows the PATH entry is usually `bun.cmd`, a batch shim that Claude Desktop cannot spawn directly.
- **`dist/` is not self-contained.** The build uses `--packages external`, because `growwapi` loads `.proto` files at import time via `__dirname` and a bundled copy resolves that path to the wrong place. `node_modules/` must stay present next to `dist/`. Pointing `args` at `src/index.ts` instead works equally well — Bun runs TypeScript directly.

---

## Smoke test

`bun run smoke` spawns the server, pipes in [scripts/smoke-test.jsonl](scripts/smoke-test.jsonl), and asserts on the responses. It forces `GROWW_LIVE_TRADING=false` in the child environment regardless of your `.env`, so it can never place an order.

Five frames: `initialize`, `tools/list`, a DRY RUN `tools/call` that must succeed, a malformed symbol that must be rejected, and an over-cap quantity that must be rejected. It checks that the two failures actually fail, that the success actually succeeds, that DRY RUN never reports `placed: true`, and that stdout stays parseable.

To drive it by hand:

```bash
cat scripts/smoke-test.jsonl | GROWW_LIVE_TRADING=false bun run src/index.ts
```

---

## Design decisions

### 1. MARKET orders, not LIMIT priced off the LTP

With only symbol and quantity, there is no price, so the choice is a market order or a limit order pegged to a fetched last-traded price. **This server uses MARKET orders**, and the tool descriptions say so plainly: the order fills at whatever the book offers, which may be materially worse than the LTP for illiquid stocks or during a volatile open.

That is the riskier default on price, and it is chosen anyway because the failure modes are not symmetric.

A limit order pegged to the LTP looks safer and mostly isn't. The LTP is already stale when it arrives; peg a limit exactly to it and in any moving market the order rests unfilled. You then have a resting DAY order the model has already reported as "placed" — and a model that believes it opened a position when it did not will reason from that false state, potentially placing a second order or a sell against shares it doesn't hold. Padding the limit by a few percent to raise the fill rate just reintroduces slippage while keeping the ambiguity.

Market orders trade a bounded, immediate, visible cost — slippage — for a **deterministic terminal state**. The order fills, and the result the model reports is the result that happened. For an autonomous caller, "I don't know whether that worked" is a worse failure than "that cost slightly more than expected." Slippage is also already bounded by `MAX_ORDER_VALUE_INR`, and DRY RUN means the default configuration cannot lose money at all.

The honest cost: on a thin small-cap, a market order can fill several percent away from the LTP. If you intend to trade illiquid names, add an explicit `limitPrice` parameter and a `place_limit_order` tool rather than changing this default — the fix is a richer contract, not a differently-guessed price.

### 2. DRY RUN as the default, not a flag you remember to set

The alternative was a per-call `confirm: true` parameter. That fails for exactly the reason it looks appealing: the model supplies it. Anything in the tool schema is under the model's control, so a confirmation parameter confirms only that the model decided to confirm — it is a speed bump, not a boundary.

Putting the switch in the process environment moves it outside the model's reach entirely. Flipping it takes a human with shell access and a restart. The cost is that enabling live trading is inconvenient, which for a tool that spends money is the correct direction to be inconvenient in.

This also drove making a DRY RUN price failure non-fatal (a live one stays fatal). An early version aborted the dry run when the price lookup failed, which meant an unreachable or misconfigured API made rehearsal impossible — precisely when you most want to inspect the payload. It now returns the full payload and states plainly that the value cap went unchecked.

### 3. A tool registry instead of inline registration

`server.ts` iterates an array of `ToolDefinition` objects; it does not know what `buy_stock` is. Adding a tool touches one file.

The indirection earns its keep by making the safety envelope structural rather than remembered. Cross-cutting behaviour — error classification, DRY RUN, credential handling, stderr-only logging — lives in the server and the shared modules, not copied into each handler. A future `get_holdings` cannot accidentally leak a stack trace or write to stdout, because it never gets the chance to.

The tradeoff is one layer of indirection over two tools, which is over-engineered at today's size. It is deliberate: the cost is paid once now, whereas retrofitting a uniform error boundary onto six tools that each grew their own is the kind of migration that leaves one handler behind. Here, that handler places trades.
