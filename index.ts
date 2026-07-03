#!/usr/bin/env bun
/**
 * omnis-cli / index.ts
 *
 * Sends local test evidence to the Omnis RegOps platform.
 *
 * USAGE
 *   omnis-run ./test-output.json              # single file (positional)
 *   omnis-run --results ./test-output.json    # single file (named flag)
 *   omnis-run --dir    ./results/             # entire directory
 *
 * Regulatory requirement IDs and build versions are read directly from the
 * test output JSON — they must be injected by your testing framework via
 * code annotations (e.g. @pytest.mark.req / // @req Jest comments).
 * You no longer need to pass --req-id or --build on the command line.
 *
 * OPTIONS
 *   <path>        (positional)  Path to a single JSON results file        (required if no flags)
 *   --results    <path>   Path to a single JSON results file               (required if no --dir)
 *   --dir        <path>   Path to a directory of JSON results files        (required if no --results)
 *   --concurrency <n>     Max simultaneous uploads when using --dir        (default: 4)
 *   --status     <val>    Execution status override: PASS | FAIL            (optional)
 *   --endpoint   <url>    Override the default Vercel endpoint              (optional)
 *   --env-file   <path>   Path to a .env file to load (default: ./.env)    (optional)
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

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, basename } from "path";
import { spawnSync } from "child_process";
import chalk from "chalk";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = "https://omnis-ui-ecru.vercel.app/api/ingest";
const API_KEY_PREFIX = "omn_";
const MIN_API_KEY_LENGTH = 8;
const DEFAULT_CONCURRENCY = 4;

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
// Build check — MUST run before any ingestion path executes.
//
// Executes `bun run typecheck` via spawnSync.  Three possible outcomes:
//   1. Combined output is 0 bytes          → HALT AND CATCH FIRE (ambiguous failure)
//   2. Non-zero exit code                  → print output, fatal()
//   3. Exit 0 AND ≥1 byte of output        → return normally, ingestion proceeds
//
// CONSTITUTION LAW IV (IEC 62304): fail loudly — never swallow a build failure.
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export function runBuildCheck(): void {
  const result = spawnSync("bun", ["run", "typecheck"], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });

  const combined = (result.stdout ?? "") + (result.stderr ?? "");

  if (combined.length === 0) {
    // HALT AND CATCH FIRE
    fatal(
      "Build check produced zero bytes of output (ambiguous failure).\n" +
      "  Cannot verify type safety. Ingestion aborted per HALT AND CATCH FIRE protocol."
    );
  }

  if (result.status !== 0) {
    console.error(chalk.red("\n[omnis] Build check failed:"));
    console.error(combined);
    fatal("Type check failed — fix all errors before ingesting evidence.");
  }

  console.log(chalk.dim("[omnis] Build check passed."));
}

// ─────────────────────────────────────────────────────────────────────────────
// Developer identity resolution
//
// Priority chain (highest → lowest):
//   1. OMNIS_DEVELOPER_EMAIL env var  — explicit override for CI/CD pipelines
//      that have no git config (e.g., Docker build containers, GitHub Actions
//      with a service account). Set this in your pipeline secrets.
//   2. git config user.email         — local repo config (most specific)
//   3. git config --global user.email — global git config
//   4. System user account            — USERNAME (Windows) / USER (Unix/macOS)
//   5. "unknown_developer"            — final safe fallback; never crashes.
//
// CONSTITUTION LAW V: This function NEVER throws. A missing email is not a
// fatal condition — we degrade gracefully and continue uploading evidence.
// The developer_email field is nullable in the schema by design.
// ─────────────────────────────────────────────────────────────────────────────

function resolveDeveloperEmail(): string {
  // 1. Explicit env var override — useful for CI/CD and Docker environments.
  const envOverride = process.env.OMNIS_DEVELOPER_EMAIL?.trim();
  if (envOverride) {
    return envOverride;
  }

  // Helper: run `git config <key>` and return the trimmed output, or null.
  function tryGitConfig(scope: string[]): string | null {
    try {
      const result = spawnSync("git", [...scope, "user.email"], {
        encoding: "utf8",
        timeout: 3000, // 3 s hard cap — never block the upload for git
        windowsHide: true,
      });
      // exit code 1 means the key is not set; non-zero for other failures
      if (result.status === 0 && result.stdout) {
        const email = result.stdout.trim();
        if (email) return email;
      }
    } catch {
      // spawnSync itself threw (e.g., git not on PATH) — swallow and continue
    }
    return null;
  }

  // 2. Local repo git config
  const localEmail = tryGitConfig(["config"]);
  if (localEmail) return localEmail;

  // 3. Global git config (catches machines where the local repo has no user set)
  const globalEmail = tryGitConfig(["config", "--global"]);
  if (globalEmail) return globalEmail;

  // 4. System user account — not an email address, but better than nothing
  //    for audit trail purposes.
  const systemUser =
    process.env.USERNAME?.trim() ||   // Windows
    process.env.USER?.trim();          // Unix / macOS
  if (systemUser) {
    return systemUser;
  }

  // 5. Final safe fallback
  return "unknown_developer";
}

// ─────────────────────────────────────────────────────────────────────────────
// Git commit hash resolution
//
// Executes `git rev-parse HEAD` via spawnSync with a 3 s timeout.
// On success (exit 0, non-empty stdout): returns the trimmed SHA-1 string.
// On any failure, empty output, or thrown error: logs a dim notice and
// returns "unknown_commit". This function NEVER throws.
//
// CONSTITUTION LAW V: A missing commit hash is not a fatal condition.
// The git_commit_hash field is carried on every IngestPayload for audit
// traceability, but the upload must not be blocked if git is unavailable
// (e.g., CI/CD containers with no git history, detached HEAD states).
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export function resolveGitCommitHash(): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const hash = result.stdout.trim();
      if (hash) return hash;
    }
    console.log(chalk.dim(
      "[omnis] git rev-parse HEAD failed or returned empty — using 'unknown_commit'."
    ));
  } catch {
    console.log(chalk.dim(
      "[omnis] git rev-parse HEAD threw — using 'unknown_commit'."
    ));
  }
  return "unknown_commit";
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker extraction — pure helper, no I/O, exported for testing (Properties 7–9)
//
// Applies the appropriate regex for the given file extension and returns
// every captured Req_ID as an array. The regex lastIndex is always reset
// before the loop so the function is safe to call repeatedly across files.
//
// Patterns:
//   .py  — @pytest.mark.requirement("REQ_ID") or @pytest.mark.requirement('REQ_ID')
//   .ts/.js — // @req: REQ_ID  (first non-whitespace token after the colon)
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export function extractMarkersFromContent(content: string, ext: string): string[] {
  const PY_RE  = /@pytest\.mark\.requirement\(\s*["']([^"']+)["']\s*\)/g;
  const REQ_RE = /\/\/\s*@req:\s*(\S+)/g;

  const re = ext === "py" ? PY_RE : REQ_RE;
  re.lastIndex = 0;

  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    found.push(m[1]);
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker scanner — recursively walks srcDir and collects all Req_IDs
//
// Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 8.3
//
// Behaviour:
//   • Resolves srcDir to an absolute path; calls fatal() if it doesn't exist.
//   • Recursively traverses with readdirSync({ withFileTypes: true }).
//   • Visits only .py, .ts, and .js files.
//   • Delegates extraction to extractMarkersFromContent per file.
//   • Wraps readFileSync in try/catch — any I/O error calls fatal() with
//     the path and OS error message (Req 8.3 / Property 16).
//   • Returns a deduplicated array via Set<string>.
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export function scanForMarkers(srcDir: string): string[] {
  const absDir = resolve(srcDir);
  if (!existsSync(absDir)) {
    fatal(`Source directory not found: ${absDir}`);
  }

  const found = new Set<string>();

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = entry.name.split(".").pop()?.toLowerCase();
        if (!ext || !["py", "ts", "js"].includes(ext)) continue;
        try {
          const content = readFileSync(fullPath, "utf8");
          const markers = extractMarkersFromContent(content, ext);
          for (const m of markers) found.add(m);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fatal(`File I/O error reading ${fullPath}: ${msg}`);
        }
      }
    }
  }

  walk(absDir);
  return Array.from(found);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parser
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export interface CliArgs {
  resultsPath: string | undefined;
  dirPath: string | undefined;
  /** Source directory to scan for requirement markers. Defaults to ".". */
  srcDir: string;
  concurrency: number;
  executionStatus: string | undefined;
  endpointOverride: string | undefined;
  envFile: string;
}

/** @internal */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // strip "bun" and "index.ts"

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  let resultsPath = get("--results");
  const dirPath = get("--dir");

  // Support bare positional path: omnis-run ./test-output.json
  // A positional arg is any non-flag token that isn't a value consumed by a known flag.
  if (!resultsPath && !dirPath) {
    const knownFlagsThatConsumeValue = new Set([
      "--results", "--dir", "--concurrency", "--status", "--endpoint", "--env-file", "--src-dir",
    ]);
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (knownFlagsThatConsumeValue.has(token)) {
        i++; // skip the consumed value
        continue;
      }
      if (!token.startsWith("--")) {
        // First bare token is treated as the results path
        resultsPath = token;
        break;
      }
    }
  }

  // No fatal() here — hierarchy mode proceeds when neither --results nor --dir is supplied.
  // (Req 3.1, 5.1: marker scan and Bedrock fallback activate when no explicit path is given.)

  if (resultsPath && dirPath) {
    fatal("--results and --dir are mutually exclusive. Use one or the other.");
  }

  const rawConcurrency = get("--concurrency");
  const concurrency = rawConcurrency ? parseInt(rawConcurrency, 10) : DEFAULT_CONCURRENCY;
  if (isNaN(concurrency) || concurrency < 1) {
    fatal("--concurrency must be a positive integer (e.g. --concurrency 4).");
  }

  return {
    resultsPath,
    dirPath,
    srcDir: get("--src-dir") ?? ".",
    concurrency,
    executionStatus: get("--status"),
    endpointOverride: get("--endpoint"),
    envFile: get("--env-file") ?? ".env",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload type (matches IngestPayload in omnis-ui/app/api/ingest/route.ts)
// req_id and build_version are no longer passed as CLI flags — they are
// injected into the test output JSON by the testing framework via code
// annotations (e.g. @pytest.mark.req / // @req Jest comments).
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export interface IngestPayload {
  results: unknown;
  execution_status?: string;
  /** Developer identity captured from git config user.email at run time.
   *  Nullable — CI/CD pipelines that cannot resolve an identity send null.
   *  Matches the developer_email column in evidence_logs (nullable TEXT). */
  developer_email?: string | null;
  /** SHA-1 commit hash from `git rev-parse HEAD`. Set to "unknown_commit" on failure. */
  git_commit_hash: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency pool
// Zero-dependency async pool: processes `tasks` with at most `limit`
// running simultaneously. Does NOT throw — each task must handle its own
// errors and return a settled result for the caller to inspect.
// ─────────────────────────────────────────────────────────────────────────────

async function asyncPool<T>(
  limit: number,
  tasks: (() => Promise<T>)[]
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < tasks.length; i++) {
    const idx = i; // capture for closure
    const p = tasks[idx]().then((res) => {
      results[idx] = res;
    });

    const managed = p.finally(() => executing.delete(managed));
    executing.add(managed);

    if (executing.size >= limit) {
      // Wait for the fastest in-flight task to finish before queuing the next.
      await Promise.race(executing);
    }
  }

  // Drain any remaining in-flight tasks.
  await Promise.all(executing);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON file reader (shared between single and bulk modes)
// ─────────────────────────────────────────────────────────────────────────────

function readJsonFile(filePath: string): unknown {
  const rawBytes = readFileSync(filePath);
  let jsonText: string;

  // Detect and strip BOMs — PowerShell's `echo`/`>` writes UTF-16 LE by
  // default (FF FE), which causes JSON.parse to throw "Unrecognized token ''".
  if (rawBytes[0] === 0xff && rawBytes[1] === 0xfe) {
    jsonText = rawBytes.slice(2).toString("utf16le");
  } else if (rawBytes[0] === 0xfe && rawBytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(rawBytes.length - 2);
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = rawBytes[i + 3];
      swapped[i + 1] = rawBytes[i + 2];
    }
    jsonText = swapped.toString("utf16le");
  } else if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
    jsonText = rawBytes.slice(3).toString("utf8");
  } else {
    jsonText = rawBytes.toString("utf8");
  }

  return JSON.parse(jsonText);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk directory mode
// ─────────────────────────────────────────────────────────────────────────────

interface FileResult {
  file: string;
  status: "success" | "failure";
  detail: string;
}

/** @internal */
export async function runBulk(
  dirPath: string,
  endpoint: string,
  apiKey: string,
  args: CliArgs,
  developerEmail: string,
  gitCommitHash: string,
): Promise<void> {
  const absDir = resolve(dirPath);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    fatal(`Directory not found or is not a directory: ${absDir}`);
  }

  // Collect all *.json files (non-recursive, top-level only)
  const jsonFiles = readdirSync(absDir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => resolve(absDir, f));

  if (jsonFiles.length === 0) {
    fatal(`No .json files found in: ${absDir}`);
  }

  const total = jsonFiles.length;
  const concurrency = args.concurrency;

  console.log("");
  console.log(chalk.cyan("━━━ Omnis RegOps — Bulk Evidence Ingestion ━━━"));
  console.log(chalk.dim(`  Directory   : ${absDir}`));
  console.log(chalk.dim(`  Files found : ${total}`));
  console.log(chalk.dim(`  Concurrency : ${concurrency} simultaneous uploads`));
  console.log(chalk.dim(`  Endpoint    : ${endpoint}`));
  console.log(chalk.dim(`  Developer   : ${developerEmail}`));
  console.log(chalk.dim(`  Key         : ${apiKey.slice(0, 8)}${"*".repeat(apiKey.length - 8)}`));
  console.log("");

  // Shared counter for progress display — updated atomically since JS is
  // single-threaded; no mutex needed.
  let completed = 0;

  const tasks = jsonFiles.map((filePath): (() => Promise<FileResult>) => {
    return async (): Promise<FileResult> => {
      const fileName = basename(filePath);

      // --- Parse ---
      let results: unknown;
      try {
        results = readJsonFile(filePath);
      } catch (err) {
        completed++;
        const msg = `JSON parse error: ${String(err)}`;
        console.log(
          chalk.red(`  [${completed}/${total}]`) +
            chalk.dim(` ${fileName}`) +
            chalk.red(` ✖  ${msg}`)
        );
        return { file: fileName, status: "failure", detail: msg };
      }

      // --- Build payload ---
      const payload: IngestPayload = {
        results,
        developer_email: developerEmail,
        git_commit_hash: gitCommitHash,
        ...(args.executionStatus && { execution_status: args.executionStatus }),
      };

      // --- Transmit ---
      try {
        const detail = await transmitOne(endpoint, apiKey, payload);
        completed++;
        console.log(
          chalk.green(`  [${completed}/${total}]`) +
            chalk.dim(` ${fileName}`) +
            chalk.green(` ✔  ${detail}`)
        );
        return { file: fileName, status: "success", detail };
      } catch (err) {
        completed++;
        const msg = String(err);
        console.log(
          chalk.red(`  [${completed}/${total}]`) +
            chalk.dim(` ${fileName}`) +
            chalk.red(` ✖  ${msg}`)
        );
        return { file: fileName, status: "failure", detail: msg };
      }
    };
  });

  // Run with concurrency cap
  const fileResults = await asyncPool<FileResult>(concurrency, tasks);

  // ─── Summary table ─────────────────────────────────────────────────────────
  const successes = fileResults.filter((r) => r.status === "success");
  const failures = fileResults.filter((r) => r.status === "failure");

  console.log("");
  console.log(chalk.cyan("━━━ Ingestion Summary ━━━"));
  console.log(
    chalk.green(`  ✔  Successfully ingested : ${successes.length}`) +
      chalk.dim(` / ${total}`)
  );

  if (failures.length > 0) {
    console.log(chalk.red(`  ✖  Failed                : ${failures.length}`) + chalk.dim(` / ${total}`));
    console.log("");
    console.log(chalk.bold("  Failed files:"));
    for (const f of failures) {
      console.log(chalk.red(`    • ${f.file}`) + chalk.dim(` — ${f.detail}`));
    }
    console.log("");
    // Exit non-zero so CI/CD pipelines can detect partial failure
    process.exit(1);
  } else {
    console.log("");
    console.log(chalk.green("  All files ingested successfully."));
    console.log("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bedrock Auto-Ingest fallback — Priority 2 of the ingestion hierarchy.
//
// Activated when the Marker Scanner finds zero annotations in the Source_Tree.
// Transmits a minimal IngestPayload with execution_status "BEDROCK_AUTO_INGEST"
// so the API can route it through the Bedrock AI pipeline server-side.
//
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 8.1
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export async function runBedrockFallback(
  endpoint: string,
  apiKey: string,
  developerEmail: string,
  gitCommitHash: string,
): Promise<void> {
  console.log(chalk.yellow(
    "[omnis] No requirement markers found. Activating Bedrock Auto-Ingest fallback."
  ));
  const payload: IngestPayload = {
    results: null,
    execution_status: "BEDROCK_AUTO_INGEST",
    developer_email: developerEmail,
    git_commit_hash: gitCommitHash,
  };
  await transmit(endpoint, apiKey, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker Scan runner — Priority 1 of the ingestion hierarchy.
//
// Orchestrates the full Priority 1 path:
//   1. Call scanForMarkers(srcDir) to find all annotated Req_IDs.
//   2. If 0 markers found → warn and return false (caller activates Bedrock).
//   3. Detect test runner(s) from file extensions present in srcDir:
//        .py files      → python -m pytest
//        .ts/.js files  → bun test
//        mixed          → run both sequentially, merge output
//   4. Capture combined stdout+stderr from each runner via spawnSync.
//   5. Build IngestPayload with captured output as `results`.
//   6. Call transmit() — which calls fatal() on any non-2xx / network error.
//   7. Return true.
//
// Requirements: 3.4, 3.5, 3.6, 4.1, 8.1, 8.2
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export async function runMarkerScan(
  srcDir: string,
  endpoint: string,
  apiKey: string,
  executionStatus: string | undefined,
  developerEmail: string,
  gitCommitHash: string,
): Promise<boolean> {
  const markers = scanForMarkers(srcDir);

  if (markers.length === 0) {
    console.warn(chalk.yellow("[omnis] No requirement markers found in source tree."));
    return false;
  }

  const absDir = resolve(srcDir);

  // Detect what file types are present in the source tree.
  // We use a simple recursive scan — no third-party libs required.
  function hasPyFiles(dir: string): boolean {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (hasPyFiles(resolve(dir, entry.name))) return true;
        } else if (entry.isFile() && entry.name.endsWith(".py")) {
          return true;
        }
      }
    } catch { /* ignore — best-effort scan */ }
    return false;
  }

  function hasJsTsFiles(dir: string): boolean {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (hasJsTsFiles(resolve(dir, entry.name))) return true;
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
          return true;
        }
      }
    } catch { /* ignore — best-effort scan */ }
    return false;
  }

  const hasPy = hasPyFiles(absDir);
  const hasJs = hasJsTsFiles(absDir);

  let combinedOutput = "";

  if (hasPy) {
    const r = spawnSync("python", ["-m", "pytest", absDir], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    combinedOutput += (r.stdout ?? "") + (r.stderr ?? "");
  }

  if (hasJs) {
    const r = spawnSync("bun", ["test", absDir], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    combinedOutput += (r.stdout ?? "") + (r.stderr ?? "");
  }

  // Edge case: neither extension detected — default to bun test.
  if (!hasPy && !hasJs) {
    const r = spawnSync("bun", ["test", absDir], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    combinedOutput += (r.stdout ?? "") + (r.stderr ?? "");
  }

  const payload: IngestPayload = {
    results: combinedOutput,
    developer_email: developerEmail,
    git_commit_hash: gitCommitHash,
    ...(executionStatus ? { execution_status: executionStatus } : {}),
  };

  await transmit(endpoint, apiKey, payload);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// API key format validation — exported for Property 13 tests.
//
// Validates that the key starts with "omn_" and meets the minimum length.
// Calls fatal() if either check fails — never returns on bad input.
//
// CONSTITUTION LAW V: no auth bypass under any code path.
// Requirements: 7.2, 7.3
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export function validateApiKey(key: string): void {
  if (!key.startsWith(API_KEY_PREFIX) || key.length < MIN_API_KEY_LENGTH) {
    fatal(
      `OMNIS_API_KEY must start with '${API_KEY_PREFIX}' and be at least ${MIN_API_KEY_LENGTH} characters.\n` +
        "  You can generate a key in the Omnis dashboard under Settings → API Keys."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic — wires the full ingestion hierarchy.
//
// Control flow (Requirements 1.1, 2.5, 5.1, 5.5, 6.2, 7.1, 7.5):
//   1. parseArgs + loadEnvFile
//   2. runBuildCheck  ← ALWAYS FIRST before any identity / ingestion logic
//   3. resolveDeveloperEmail
//   4. resolveGitCommitHash  ← threaded explicitly, never stored in module scope
//   5. validateApiKey
//   6. resolveEndpoint
//   7. Mode branch:
//       --dir      → runBulk (bypasses hierarchy)
//       --results  → single-file ingest (bypasses hierarchy)
//       neither    → runMarkerScan → runBedrockFallback if !markerHit
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const args = parseArgs(process.argv);

  // 1. Load .env (system env always wins — safe for CI/CD)
  loadEnvFile(args.envFile);

  // 2. Build gate — MUST execute before any identity resolution or ingestion.
  //    CONSTITUTION LAW IV / IEC 62304: fail loudly on broken builds.
  runBuildCheck();

  // 3. Resolve developer identity.
  //    Runs git config user.email with a 3 s timeout; degrades gracefully
  //    to system user or "unknown_developer" if git is unavailable.
  //    CONSTITUTION LAW V: never crashes the CLI — email is informational.
  const developerEmail = resolveDeveloperEmail();

  // 4. Resolve git commit hash — once, threaded explicitly to all paths.
  //    Never stored in a module-level mutable. Falls back to "unknown_commit".
  const gitCommitHash = resolveGitCommitHash();

  // 5. Read and validate the API key — CONSTITUTION LAW II: never hardcoded.
  const apiKey = process.env.OMNIS_API_KEY?.trim();
  if (!apiKey) {
    fatal(
      "OMNIS_API_KEY environment variable is not set.\n" +
        "  Set it in your .env file or export it in your shell:\n" +
        "    export OMNIS_API_KEY=omn_<your_key>"
    );
  }
  validateApiKey(apiKey!);

  // 6. Resolve the endpoint (flag > env var > hardcoded default)
  const endpoint =
    args.endpointOverride ??
    process.env.OMNIS_API_ENDPOINT ??
    DEFAULT_ENDPOINT;

  // ── Branch: bulk directory mode — bypasses hierarchy entirely (Req 6.2) ──
  if (args.dirPath) {
    await runBulk(args.dirPath, endpoint, apiKey!, args, developerEmail, gitCommitHash);
    return;
  }

  // ── Branch: single file mode — bypasses hierarchy entirely (Req 5.1) ─────
  if (args.resultsPath) {
    const resultsAbs = resolve(args.resultsPath);
    if (!existsSync(resultsAbs)) {
      fatal(`Results file not found: ${resultsAbs}`);
    }

    let results: unknown;
    try {
      results = readJsonFile(resultsAbs);
    } catch (err) {
      fatal(
        `Failed to parse results file as JSON: ${resultsAbs}\n  ${String(err)}\n\n` +
        "  Tip: If you created this file with PowerShell echo or >, it may be\n" +
        "  UTF-16 encoded. Re-save it as UTF-8:\n" +
        "    $data | ConvertTo-Json | Out-File -FilePath test-output.json -Encoding utf8"
      );
    }

    // Build the payload — git_commit_hash always populated (Req 5.5, 2.5)
    const payload: IngestPayload = {
      results,
      developer_email: developerEmail,
      git_commit_hash: gitCommitHash,
      ...(args.executionStatus && { execution_status: args.executionStatus }),
    };

    // Header
    console.log("");
    console.log(chalk.cyan("━━━ Omnis RegOps — Evidence Ingestion ━━━"));
    console.log(chalk.dim(`  Endpoint  : ${endpoint}`));
    console.log(chalk.dim(`  Results   : ${resultsAbs}`));
    console.log(chalk.dim(`  Developer : ${developerEmail}`));
    console.log(chalk.dim(`  Commit    : ${gitCommitHash}`));
    console.log(chalk.dim(`  Key       : ${apiKey!.slice(0, 8)}${"*".repeat(apiKey!.length - 8)}`));
    console.log("");

    await transmit(endpoint, apiKey!, payload);
    return;
  }

  // ── Branch: hierarchy mode — Marker Scan → Bedrock fallback (Req 3.1, 4.1) ─
  const markerHit = await runMarkerScan(
    args.srcDir,
    endpoint,
    apiKey!,
    args.executionStatus,
    developerEmail,
    gitCommitHash,
  );
  if (!markerHit) {
    await runBedrockFallback(endpoint, apiKey!, developerEmail, gitCommitHash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// transmitOne — returns a short success string or THROWS on error.
// Used by bulk mode so it can catch per-file errors without crashing the pool.
// ─────────────────────────────────────────────────────────────────────────────

async function transmitOne(
  endpoint: string,
  apiKey: string,
  payload: IngestPayload
): Promise<string> {
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "omnis-cli/1.0.0",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Network error — ${String(err)}`);
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

  if (response.status === 200 || response.status === 201) {
    const data = body as Record<string, unknown>;
    const logId = data.log_id ? `log_id=${data.log_id}` : `HTTP ${response.status}`;
    return logId;
  }

  const data = body as Record<string, unknown>;
  const detail =
    (data?.detail as string) ??
    (data?.error as string) ??
    JSON.stringify(body, null, 2);

  throw new Error(`HTTP ${response.status} — ${detail}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// transmit — single-file mode, uses process.exit on failure (original behaviour)
// ─────────────────────────────────────────────────────────────────────────────

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
  omnis-run                          # hierarchy mode (marker scan → Bedrock fallback)
  omnis-run <path>                   # single file override (positional)
  omnis-run --results <path>         # single file override (named flag)
  omnis-run --dir    <path>          # bulk directory override

Regulatory requirement IDs and build versions are read directly from the
test output JSON. Tag your tests with code annotations before running:

  ${chalk.dim("# Python (PyTest)")}
  @pytest.mark.requirement("21_CFR_820_30")
  def test_database_encryption(): ...

  ${chalk.dim("// JavaScript / TypeScript")}
  // @req: IEC_62304_5_1
  test('authenticates user session', () => { ... });

${chalk.bold("OPTIONS")}
  <path>            Path to a single JSON results file                (optional — bypasses hierarchy)
  --results <path>  Path to a single JSON results file                (optional — bypasses hierarchy)
  --dir     <path>  Path to a directory of JSON results files         (optional — bypasses hierarchy)
  --src-dir <path>  Directory to scan for requirement markers         (default: ".")
  --concurrency <n> Max simultaneous uploads for --dir                (default: 4)
  --status  <val>   Execution status: PASS or FAIL                    (optional, default: PASS)
  --endpoint <url>  Override the default Vercel endpoint              (optional)
  --env-file <path> Path to a .env file                              (optional, default: ./.env)
  --help            Show this help text and exit

${chalk.bold("MODES")}
  ${chalk.underline("Hierarchy mode")} (default — no --results or --dir):
    Priority 1: Marker Scan — Scans --src-dir for @pytest.mark.requirement /
                // @req: annotations, runs the associated tests, and ingests
                the results.
    Priority 2: Bedrock Auto-Ingest — If no annotations are found, activates
                AI-assisted ingestion via AWS Bedrock (no test output file
                required).

  ${chalk.underline("--results override")}:
    Bypasses the hierarchy entirely. Ingests the provided JSON results file
    directly.

  ${chalk.underline("--dir bulk mode")}:
    Bypasses the hierarchy entirely. Ingests all .json files in the given
    directory.

${chalk.bold("ENVIRONMENT VARIABLES")}
  OMNIS_API_KEY       Your org API key (must start with "omn_")       (required)
  OMNIS_API_ENDPOINT  Override the target endpoint                    (optional)

${chalk.bold("EXAMPLES")}
  # Hierarchy mode — auto-scan current directory for annotations
  omnis-run

  # Hierarchy mode — scan a specific source directory
  omnis-run --src-dir ./src

  # Single file override — bypass hierarchy with a pre-built results file
  omnis-run ./test-output.json

  # Bulk directory ingestion (max 4 concurrent)
  omnis-run --dir ./results/

  # Bulk with custom concurrency
  omnis-run --dir ./results/ --concurrency 3

  # CI/CD with a custom .env path
  omnis-run ./results/pytest.json --env-file /secrets/.env.omnis

${chalk.bold("API KEY FORMAT")}
  Keys look like:  omn_a1b2c3d4e5f6...
  Generate one in the Omnis dashboard under Settings → API Keys.
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — only execute when this file is the direct entry point,
// not when it is imported as a module (e.g. during testing).
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  run().catch((err: unknown) => {
    console.error(chalk.red("\n✖  Unhandled error:"), err);
    process.exit(1);
  });
}
