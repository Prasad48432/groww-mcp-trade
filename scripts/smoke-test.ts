#!/usr/bin/env bun
/**
 * Smoke test: drives the server over stdio with hand-written JSON-RPC and
 * prints each response. Verifies the handshake, the tool list, and both the
 * happy and rejected paths of a tools/call -- without touching the brokerage.
 *
 * DRY RUN is forced on in the child environment regardless of what is in .env,
 * so this script can never place an order.
 *
 *   bun run smoke
 *
 * The same frames can be piped in by hand:
 *   cat scripts/smoke-test.jsonl | GROWW_LIVE_TRADING=false bun run src/index.ts
 */

const FRAMES = await Bun.file(new URL("./smoke-test.jsonl", import.meta.url)).text();

const LABELS: Record<number, string> = {
  1: "initialize -- handshake",
  2: "tools/list -- tool discovery",
  3: "tools/call preview_buy_order SBIN x1 -- DRY RUN, should succeed",
  4: "tools/call preview_buy_order with a malformed symbol -- should be rejected",
  5: "tools/call preview_sell_order with quantity 999999 -- should exceed the quantity cap",
};

const child = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit", // server diagnostics stream through, proving stdout stays clean
  env: {
    ...process.env,
    // Belt and braces: never let a stray .env turn this into a real trade.
    GROWW_LIVE_TRADING: "false",
    MAX_QUANTITY_PER_ORDER: process.env.MAX_QUANTITY_PER_ORDER ?? "10",
    MAX_ORDER_VALUE_INR: process.env.MAX_ORDER_VALUE_INR ?? "10000",
  },
});

child.stdin.write(FRAMES);
await child.stdin.flush();

let failures = 0;
let buffer = "";
const seen = new Set<number>();

const timeout = setTimeout(() => {
  console.error("\nTimed out waiting for responses.");
  child.kill();
  process.exit(1);
}, 30_000);

for await (const chunk of child.stdout) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;

    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      // Anything unparseable on stdout means the JSON-RPC stream is corrupted,
      // which is exactly the failure a stray console.log would cause.
      console.error(`\nNON-JSON ON STDOUT (transport corrupted): ${line}`);
      failures++;
      continue;
    }

    if (typeof message.id !== "number") continue;
    seen.add(message.id);

    console.log(`\n${"=".repeat(72)}`);
    console.log(`[${message.id}] ${LABELS[message.id] ?? "response"}`);
    console.log("=".repeat(72));

    if (message.error) {
      console.log(`protocol error: ${message.error.message}`);
      // Frames 4 and 5 are meant to fail; only the others count against us.
      if (message.id < 4) failures++;
      continue;
    }

    const result = message.result;

    if (message.id === 1) {
      console.log(`server: ${result.serverInfo?.name} v${result.serverInfo?.version}`);
      console.log(`protocol: ${result.protocolVersion}`);
    } else if (message.id === 2) {
      for (const tool of result.tools ?? []) {
        const params = Object.keys(tool.inputSchema?.properties ?? {}).join(", ");
        console.log(`- ${tool.name}(${params})  destructive=${tool.annotations?.destructiveHint}`);
      }
      if ((result.tools?.length ?? 0) !== 2) failures++;
    } else {
      console.log(`isError: ${result.isError === true}`);
      for (const block of result.content ?? []) console.log(block.text);

      const shouldError = message.id >= 4;
      if ((result.isError === true) !== shouldError) {
        console.error(`UNEXPECTED: isError should be ${shouldError}`);
        failures++;
      }
      // A DRY RUN result must never claim an order was placed.
      if (message.id === 3 && /"placed":\s*true/.test(JSON.stringify(result))) {
        console.error("UNEXPECTED: DRY RUN reported placed=true");
        failures++;
      }
    }

    if (seen.size === Object.keys(LABELS).length) {
      clearTimeout(timeout);
      child.kill();

      console.log(`\n${"=".repeat(72)}`);
      console.log(failures === 0 ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failures} problem(s))`);
      console.log("=".repeat(72));
      process.exit(failures === 0 ? 0 : 1);
    }
  }
}

clearTimeout(timeout);
console.error("\nServer closed stdout before all responses arrived.");
process.exit(1);
