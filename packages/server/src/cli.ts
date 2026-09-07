import { createGateway, type CreateGatewayOptions } from "./gateway.js";
import { readFileSync } from "node:fs";

/**
 * Config-driven CLI entry:
 *   prism-server --config prism.config.json
 *   PRISM_CONFIG=path node dist/cli.js
 *
 * See config.example.json for the schema.
 */
async function main(): Promise<void> {
  const configPath =
    process.argv.find((a, i, arr) => arr[i - 1] === "--config") ??
    process.env.PRISM_CONFIG ??
    "prism.config.json";
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    console.error(`[prism-server] cannot read config: ${configPath}`);
    process.exit(1);
  }
  const config = JSON.parse(raw) as CreateGatewayOptions;
  await createGateway(config);
  console.log(`[prism-server] gateway started from ${configPath}`);
}

void main().catch((err) => {
  console.error("[prism-server] fatal", err);
  process.exit(1);
});
