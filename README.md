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

| Script              | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `bun run start`     | Run the server on stdio                     |
| `bun run dev`       | Same, with reload on change                 |
| `bun run build`     | Bundle to `dist/index.js`                   |
| `bun run typecheck` | `tsc --noEmit`                              |
| `bun run smoke`     | Drive the server with hand-written JSON-RPC |

---

## Tools

| Tool         | Input                                                        | Effect                                                    |
| ------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| `buy_stock`  | `tradingSymbol` (e.g. `SBIN`), `quantity` (positive integer) | Places a **MARKET BUY** on NSE / CASH / CNC, DAY validity |
| `sell_stock` | same                                                         | Places a **MARKET SELL**, same defaults                   |

Only symbol and quantity are model-supplied. Exchange, segment, product, validity, and order type are server-side constants — the model cannot switch to intraday leverage, hop exchanges, or change the order type.

Both tools are annotated `destructiveHint: true` and `openWorldHint: true` so MCP clients prompt a human before invoking.

Adding a tool means writing one `ToolDefinition` and appending it to the array in [src/tools/index.ts](src/tools/index.ts) — `server.ts` iterates the registry and needs no edit. `get_holdings`, `get_quote`, and `cancel_order` are the obvious next ones; they map to `groww.holdings.list`, `groww.liveData.getQuote`, and `groww.orders.cancel`.

---
