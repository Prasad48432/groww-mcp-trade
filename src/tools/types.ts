/**
 * Tool registry contract.
 *
 * Adding a tool means writing one of these and appending it to the array in
 * ./index.ts -- server.ts iterates the registry and needs no edit.
 */

import type { ZodRawShape } from "zod";
import type { Config } from "../config.js";

/** What a handler may return; the server wraps it into an MCP tool result. */
export interface ToolOutput {
  /** Rendered as the human-readable text block. */
  summary: string;
  /** Attached as pretty-printed JSON so the caller sees the full payload. */
  data?: Record<string, unknown>;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  /**
   * Config-derived, because the name is the strongest claim a tool makes and
   * it must match what the code does. In DRY RUN this server does not buy
   * stock -- it previews an order -- so exposing `buy_stock` overstates the
   * capability in exactly the way a description saying "REAL MONEY" did.
   * The name and the behaviour have to agree in both modes.
   */
  name: (config: Config) => string;
  /** Config-derived like the description -- some clients show only the title. */
  title: (config: Config) => string;
  /**
   * Built from config at registration time, not fixed at module load, because
   * a DRY RUN tool and a LIVE tool are genuinely different things and the
   * description is the only evidence the model gets. A static string that
   * warns about real money while the server is simulating is simply false,
   * and a caller that believes it will refuse to use a harmless tool.
   */
  description: (config: Config) => string;
  inputSchema: Shape;
  /**
   * MCP tool annotations. `destructiveHint` and `openWorldHint` matter here:
   * clients use them to decide whether to prompt a human before invoking.
   * Also config-derived: in DRY RUN nothing is destructive because nothing
   * leaves the process.
   */
  annotations?: (config: Config) => {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /**
   * Throw ValidationError or ExecutionError to produce an error result.
   * Any other throw is caught by the server and reported generically.
   */
  handler: (args: any, config: Config) => Promise<ToolOutput>;
}
