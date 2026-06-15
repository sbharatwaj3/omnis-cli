#!/usr/bin/env bun
/**
 * omnis-cli / index.ts
 *
 * Sends local test evidence to the Omnis RegOps platform.
 *
 * USAGE
 *   bun run index.ts --results ./test-output.json [options]
 *
 * OPTIONS
 *   --results    <path>   Path to the JSON file containing test results  (required)
 *   --req-id     <id>     Regulatory rule ID, e.g. "FDA-820.30g"          (optional)
 *   --build      <ver>    Build/version string, e.g. "v1.2.3"             (optional)
 *   --status     <val>    Execution status override: PASS | FAIL           (optional)
 *   --endpoint   <url>    Override the default Vercel endpoint             (optional)
 *   --env-file   <path>   Path to a .env file to load (default: ./.env)   (optional)
 *   --help               Show this help text and exit
 *
 * ENVIRONMENT VARIABLES
 *   OMNIS_API_KEY      Required. Your org's API key (starts with "omn_").
 *   OMNIS_API_ENDPOINT Optional. Override the target endpoint URL.
 *
 * AUTHENTICATION
 *   The raw API key is sent as:   Authorization: Bearer omn_<key>
 *   The /api/ingest endpoint verifies it against the salted SHA-256 hash
 *   stored in organization_api_keys — the raw key is never persisted.
 *
 * CONSTITUTION ALIGNMENT
 *   • No hardcoded secrets — all from env vars (Law II).
 *   • No auth bypass — key is mandatory; we fail loud if missing (Law V).
 *   • No silent failures — all network/file errors surface immediately.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import chalk from "chalk";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = "https://omnis-ui-ecru.vercel.app/api/ingest";
const API_KEY_PREFIX = "omn_";
const MIN_API_KEY_LENGTH = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal .env loader
// We don't pull in dotenv as a hard dep — Bun has built-in .env support,
// but the --env-file flag lets users point at a non-default path.
// ─────────────────────────────────────────────────────────────────────────────

function loadEnvFile(filePath: string): void {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    // Not fatal — CI/CD injects vars via the system environment.
    console.log(
      chalk.dim(
        `[omnis] No .env file found at '${abs}' — proceeding with system env.`
      )
    );
    return;
  }

  // Read as raw bytes so we can handle any encoding PowerShell may have used.
  const rawBytes = readFileSync(abs);
  let content: string;

  // Detect and re-encode UTF-16 LE (FF FE BOM) — PowerShell's default
  // when using `echo`, `>`, or `Out-File` without -Encoding UTF8.
  if (rawBytes[0] === 0xff && rawBytes[1] === 0xfe) {
    content = rawBytes.slice(2).toString("utf16le");
  }
  // Detect UTF-16 BE (FE FF BOM) — less common but possible.
  else if (rawBytes[0] === 0xfe && rawBytes[1] === 0xff) {
    // Swap byte pairs to decode big-endian UTF-16.
    const swapped = Buffer.allocUnsafe(rawBytes.length - 2);
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = rawBytes[i + 3];
      swapped[i + 1] = rawBytes[i + 2];
    }
    content = swapped.toString("utf16le");
  }
  // UTF-8 BOM (EF BB BF) — written by some editors and older PowerShell.
  else if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
    content = rawBytes.slice(3).toString("utf8");
  }
  // Plain UTF-8 / ASCII — the normal case.
  else {
    content = rawBytes.toString("utf8");
  }

  // Normalise line endings: CRLF (\r\n) → LF (\n), stray CR → gone.
  // PowerShell writes CRLF by default; without this the \r would be
  // appended to every value, silently corrupting key comparisons.
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let loaded = 0;

  for (const raw of lines) {
    const line = raw.trim();
    // Skip blanks and comments
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    // Strip optional surrounding quotes from the value
    const rawVal = line.slice(eqIdx + 1).trim();
    const value = rawVal.replace(/^['"]|['"]$/g, "");

    // Only set if not already in the environment (system env wins)
    if (!process.env[key]) {
      process.env[key] = value;
      loaded++;
    }
  }

  console.log(
    chalk.dim(`[omnis] Loaded ${loaded} variable(s) from '${abs}'.`)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parser
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  resultsPath: string;
  reqId: string | undefined;
  buildVersion: string | undefined;
  executionStatus: string | undefined;
  endpointOverride: string | undefined;
  envFile: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // strip "bun" and "index.ts"

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const resultsPath = get("--results");
  if (!resultsPath) {
    fatal(
      "--results is required.\n" +
        "  Example: bun run index.ts --results ./test-output.json"
    );
  }

  return {
    resultsPath: resultsPath as string,
    reqId: get("--req-id"),
    buildVersion: get("--build"),
    executionStatus: get("--status"),
    endpointOverride: get("--endpoint"),
    envFile: get("--env-file") ?? ".env",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload type (matches IngestPayload in omnis-ui/app/api/ingest/route.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface IngestPayload {
  results: unknown;
  build_version?: string;
  req_id?: string;
  execution_status?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const args = parseArgs(process.argv);

  // 1. Load .env (system env always wins — safe for CI/CD)
  loadEnvFile(args.envFile);

  // 2. Read the API key — CONSTITUTION LAW II: never hardcoded
  const apiKey = process.env.OMNIS_API_KEY;
  if (!apiKey) {
    fatal(
      "OMNIS_API_KEY environment variable is not set.\n" +
        "  Set it in your .env file or export it in your shell:\n" +
        "    export OMNIS_API_KEY=omn_<your_key>"
    );
  }
  if (!apiKey!.startsWith(API_KEY_PREFIX) || apiKey!.length < MIN_API_KEY_LENGTH) {
    fatal(
      `OMNIS_API_KEY must start with '${API_KEY_PREFIX}' and be at least ${MIN_API_KEY_LENGTH} characters.\n` +
        "  You can generate a key in the Omnis dashboard under Settings → API Keys."
    );
  }

  // 3. Resolve the endpoint (flag > env var > hardcoded default)
  const endpoint =
    args.endpointOverride ??
    process.env.OMNIS_API_ENDPOINT ??
    DEFAULT_ENDPOINT;

  // 4. Read and parse the results file
  const resultsAbs = resolve(args.resultsPath);
  if (!existsSync(resultsAbs)) {
    fatal(`Results file not found: ${resultsAbs}`);
  }

  let results: unknown;
  try {
    const rawBytes = readFileSync(resultsAbs);
    let jsonText: string;

    // Detect and strip BOMs — PowerShell's `echo`/`>` writes UTF-16 LE by
    // default (FF FE), which causes JSON.parse to throw "Unrecognized token ''".
    if (rawBytes[0] === 0xff && rawBytes[1] === 0xfe) {
      // UTF-16 LE: skip the 2-byte BOM, decode the rest as UTF-16 LE.
      jsonText = rawBytes.slice(2).toString("utf16le");
    } else if (rawBytes[0] === 0xfe && rawBytes[1] === 0xff) {
      // UTF-16 BE: swap byte pairs after skipping the 2-byte BOM.
      const swapped = Buffer.allocUnsafe(rawBytes.length - 2);
      for (let i = 0; i < swapped.length; i += 2) {
        swapped[i] = rawBytes[i + 3];
        swapped[i + 1] = rawBytes[i + 2];
      }
      jsonText = swapped.toString("utf16le");
    } else if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
      // UTF-8 BOM: skip the 3-byte BOM, rest is plain UTF-8.
      jsonText = rawBytes.slice(3).toString("utf8");
    } else {
      // Plain UTF-8 / ASCII — the normal case.
      jsonText = rawBytes.toString("utf8");
    }

    results = JSON.parse(jsonText);
  } catch (err) {
    fatal(
      `Failed to parse results file as JSON: ${resultsAbs}\n  ${String(err)}\n\n` +
      "  Tip: If you created this file with PowerShell echo or >, it may be\n" +
      "  UTF-16 encoded. Re-save it as UTF-8:\n" +
      "    $data | ConvertTo-Json | Out-File -FilePath test-output.json -Encoding utf8"
    );
  }

  // 5. Build the payload
  const payload: IngestPayload = {
    results,
    ...(args.buildVersion && { build_version: args.buildVersion }),
    ...(args.reqId && { req_id: args.reqId }),
    ...(args.executionStatus && { execution_status: args.executionStatus }),
  };

  // 6. Transmit
  console.log("");
  console.log(chalk.cyan("━━━ Omnis RegOps — Evidence Ingestion ━━━"));
  console.log(chalk.dim(`  Endpoint : ${endpoint}`));
  console.log(chalk.dim(`  Results  : ${resultsAbs}`));
  if (args.reqId) console.log(chalk.dim(`  Req ID   : ${args.reqId}`));
  if (args.buildVersion) console.log(chalk.dim(`  Build    : ${args.buildVersion}`));
  console.log(chalk.dim(`  Key      : ${apiKey!.slice(0, 8)}${"*".repeat(apiKey!.length - 8)}`));
  console.log("");

  await transmit(endpoint, apiKey!, payload);
}

async function transmit(
  endpoint: string,
  apiKey: string,
  payload: IngestPayload
): Promise<void> {
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // Identify this tool in server logs
        "User-Agent": "omnis-cli/1.0.0",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout, etc.)
    fatal(
      `Network error — could not reach ${endpoint}\n` +
        `  ${String(err)}\n\n` +
        "  Check your internet connection and verify the endpoint URL."
    );
  }

  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch {
      body = { raw: await response.text() };
    }
  } else {
    body = { raw: await response.text() };
  }

  if (response.status === 201 || response.status === 200) {
    const data = body as Record<string, unknown>;
    console.log(
      chalk.green(
        `✔  Evidence ingested successfully (HTTP ${response.status})`
      )
    );
    console.log("");
    if (data.log_id)
      console.log(chalk.dim(`  Log ID  : ${data.log_id}`));
    if (data.org_id)
      console.log(chalk.dim(`  Org ID  : ${data.org_id}`));
    if (data.build_id)
      console.log(chalk.dim(`  Build ID: ${data.build_id}`));
    if (data.req_id)
      console.log(chalk.dim(`  Req ID  : ${data.req_id}`));
    if (data.execution_timestamp)
      console.log(chalk.dim(`  Stamped : ${data.execution_timestamp}`));
    console.log("");
    return;
  }

  // Non-2xx — surface the server's error message
  const data = body as Record<string, unknown>;
  const detail =
    (data?.detail as string) ??
    (data?.error as string) ??
    JSON.stringify(body, null, 2);

  if (response.status === 401) {
    fatal(
      `HTTP 401 Unauthorized — API key rejected.\n\n` +
        `  Server said: ${detail}\n\n` +
        "  Troubleshooting:\n" +
        "    1. Confirm OMNIS_API_KEY starts with 'omn_'.\n" +
        "    2. Verify the key was generated in your Omnis dashboard.\n" +
        "    3. Ensure the key has not been revoked."
    );
  }

  if (response.status === 400) {
    fatal(
      `HTTP 400 Bad Request — payload rejected.\n\n` +
        `  Server said: ${detail}\n\n` +
        "  Ensure your results file contains valid JSON with at least one field."
    );
  }

  if (response.status === 500) {
    fatal(
      `HTTP 500 Internal Server Error.\n\n` +
        `  Server said: ${detail}\n\n` +
        "  This is a server-side issue. Check the Vercel logs or contact support."
    );
  }

  fatal(
    `HTTP ${response.status} — unexpected response.\n\n` +
      `  Server said: ${detail}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fatal(message: string): never {
  console.error("");
  console.error(chalk.red("✖  Error: " + message));
  console.error("");
  process.exit(1);
}

function printHelp(): void {
  console.log(`
${chalk.cyan("omnis-cli")} — Ship signed test evidence to the Omnis RegOps platform.

${chalk.bold("USAGE")}
  bun run index.ts --results <path> [options]

${chalk.bold("OPTIONS")}
  --results   <path>  Path to a JSON file with test results      (required)
  --req-id    <id>    Regulatory rule ID, e.g. "FDA-820.30g"     (optional)
  --build     <ver>   Build/version string, e.g. "v1.2.3"        (optional)
  --status    <val>   Execution status: PASS or FAIL              (optional, default: PASS)
  --endpoint  <url>   Override the default Vercel endpoint        (optional)
  --env-file  <path>  Path to a .env file                        (optional, default: ./.env)
  --help              Show this help text and exit

${chalk.bold("ENVIRONMENT VARIABLES")}
  OMNIS_API_KEY       Your org API key (must start with "omn_")  (required)
  OMNIS_API_ENDPOINT  Override the target endpoint               (optional)

${chalk.bold("EXAMPLES")}
  # Basic ingestion
  bun run index.ts --results ./test-output.json

  # With regulatory tagging
  bun run index.ts --results ./test-output.json --req-id "FDA-820.30g" --build "v1.2.3"

  # CI/CD with a custom .env path
  bun run index.ts --results ./results/pytest.json --env-file /secrets/.env.omnis

${chalk.bold("API KEY FORMAT")}
  Keys look like:  omn_a1b2c3d4e5f6...
  Generate one in the Omnis dashboard under Settings → API Keys.
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

run().catch((err: unknown) => {
  console.error(chalk.red("\n✖  Unhandled error:"), err);
  process.exit(1);
});
