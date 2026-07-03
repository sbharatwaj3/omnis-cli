# Requirements Document

## Introduction

The Smart Ingestion Hierarchy refactors the `omnis-cli/index.ts` entry point to implement a three-tier, priority-ordered evidence ingestion strategy. Currently the CLI requires the caller to supply a pre-built JSON results file (`--results` or a positional path). The new design makes that flag optional: the CLI can now autonomously discover test annotations in source code (Priority 1 — Marker Scan), fall back to AWS Bedrock AI auto-ingestion when no annotations are found (Priority 2 — Bedrock Auto-Ingest), and still accept a pre-built results file when the caller explicitly supplies one (Optional Override — `--results`). Two supporting concerns are also addressed: every ingested payload must carry a new `git_commit_hash` field, and the CLI must run a strict local build/type-check (`bun run typecheck`) before any ingestion path executes.

All changes are strictly confined to `omnis-cli/index.ts`. No other file — `omnis-api/`, `omnis-ui/`, `omnis-run/main.go`, Supabase migrations — may be modified.

## Glossary

- **CLI**: The `omnis-cli/index.ts` command-line tool, executed via `bun`.
- **Marker_Scanner**: The module within the CLI responsible for recursively scanning source files for requirement annotation patterns.
- **Annotation**: A source-code comment that associates a test with a regulatory requirement — either `@pytest.mark.requirement("REQ_ID")` (Python) or `// @req: REQ_ID` (JS/TS).
- **Req_ID**: The regulatory requirement identifier string extracted from an Annotation (e.g., `IEC-62304-5.5.3`).
- **Build_Checker**: The module within the CLI that invokes `bun run typecheck` via `spawnSync` before any ingestion executes.
- **Bedrock_Auto_Ingestor**: The module within the CLI that triggers the Bedrock AI pipeline when no Annotations are found.
- **IngestPayload**: The JSON object transmitted to the `/api/ingest` endpoint.
- **developer_email**: The git user identity field already present in `IngestPayload`, resolved by `resolveDeveloperEmail()`.
- **git_commit_hash**: A new field added to `IngestPayload` representing the SHA-1 commit hash from `git rev-parse HEAD`.
- **Source_Tree**: The directory rooted at `--src-dir` (or the current working directory by default) that the Marker_Scanner traverses.
- **OMNIS_API_KEY**: The mandatory environment variable containing the organisation API key (prefix `omn_`).

---

## Requirements

### Requirement 1: Strict Build Check Before Any Ingestion

**User Story:** As a regulated software developer, I want the CLI to verify the project compiles cleanly before uploading any evidence, so that I never accidentally ingest artifacts from a broken build.

#### Acceptance Criteria

1. WHEN the CLI is invoked for any ingestion path (Marker Scan, Bedrock Auto-Ingest, or `--results` override), THE Build_Checker SHALL execute `bun run typecheck` via `spawnSync` before any ingestion logic runs.
2. WHEN `bun run typecheck` exits with a non-zero exit code, THE Build_Checker SHALL print the captured stdout and stderr output to the console, then immediately terminate the CLI process with a non-zero exit code without performing any ingestion or git push, regardless of output size.
3. IF `bun run typecheck` captures zero bytes of combined stdout and stderr output, THEN THE Build_Checker SHALL trigger the HALT AND CATCH FIRE protocol: print a diagnostic message stating the build produced no output (ambiguous failure), and terminate the CLI process with a non-zero exit code.
4. WHEN `bun run typecheck` exits with exit code zero and captures at least one byte of output, THE Build_Checker SHALL allow the CLI to proceed to the ingestion hierarchy; subsequent components (API key validation, marker scan, etc.) may still independently block ingestion.
5. THE Build_Checker SHALL use `spawnSync` with a timeout of no less than 60 000 milliseconds to avoid blocking the process indefinitely on slow machines.

---

### Requirement 2: Git Commit Hash Resolution

**User Story:** As a QA manager, I want every ingested evidence payload to include the exact git commit hash that was tested, so that I can trace each evidence log back to a specific point in version history.

#### Acceptance Criteria

1. THE CLI SHALL resolve `git_commit_hash` by executing `git rev-parse HEAD` via `spawnSync` with a timeout of 3 000 milliseconds.
2. WHEN `git rev-parse HEAD` exits with exit code zero and returns a non-empty string, THE CLI SHALL trim whitespace from the output and use the resulting SHA-1 string as `git_commit_hash`.
3. IF `git rev-parse HEAD` fails, times out, or returns an empty string, THEN THE CLI SHALL set `git_commit_hash` to the string `"unknown_commit"` without crashing.
4. THE `IngestPayload` interface SHALL include a `git_commit_hash` field of type `string | null`.
5. THE CLI SHALL populate `git_commit_hash` in every `IngestPayload` regardless of which ingestion path is active (Marker Scan, Bedrock Auto-Ingest, or `--results` override).

---

### Requirement 3: Priority 1 — Marker Scan Mode

**User Story:** As a developer who annotates tests with regulatory requirement markers, I want the CLI to automatically find those annotations and run the associated tests, so that I do not have to manually assemble a results file.

#### Acceptance Criteria

1. WHEN the CLI is invoked without a `--results` flag and without a positional results path, THE Marker_Scanner SHALL recursively traverse the Source_Tree to locate all files with extensions `.py`, `.ts`, and `.js`.
2. WHEN traversing the Source_Tree, THE Marker_Scanner SHALL extract `Req_ID` values from all occurrences of the pattern `@pytest.mark.requirement("REQ_ID")` in `.py` files.
3. WHEN traversing the Source_Tree, THE Marker_Scanner SHALL extract `Req_ID` values from all occurrences of the pattern `// @req: REQ_ID` in `.ts` and `.js` files.
4. WHEN at least one `Req_ID` is found, THE Marker_Scanner SHALL deduplicate the list of `Req_ID` values and run the associated tests for those requirements.
5. WHEN the tests associated with the discovered `Req_ID` values complete, THE CLI SHALL build and transmit an `IngestPayload` containing the captured test results, `developer_email`, and `git_commit_hash`.
6. WHEN the Source_Tree contains zero matching files OR zero Annotations are found in any scanned file, THE CLI SHALL print a console warning stating that no requirement markers were found, and SHALL proceed to Priority 2 (Bedrock Auto-Ingest) without halting.
7. THE Marker_Scanner SHALL use `readdirSync` with recursive traversal and SHALL NOT require any third-party file-glob library beyond the built-in `fs` module.
8. IF the Source_Tree path does not exist, THEN THE CLI SHALL print an error and terminate with a non-zero exit code.

---

### Requirement 4: Priority 2 — Bedrock Auto-Ingest Fallback

**User Story:** As a developer running the CLI in a repository without requirement markers, I want the CLI to automatically fall back to AI-assisted ingestion via Bedrock, so that evidence is still captured without manual intervention.

#### Acceptance Criteria

1. WHEN the Marker Scan phase completes with zero Annotations found, THE Bedrock_Auto_Ingestor SHALL activate as the automatic fallback ingestion path.
2. WHEN the Bedrock_Auto_Ingestor activates, THE CLI SHALL print a console message indicating that Bedrock Auto-Ingest is running as a fallback.
3. THE Bedrock_Auto_Ingestor SHALL transmit an `IngestPayload` to the `/api/ingest` endpoint with the `execution_status` field set to reflect the AI-driven ingestion mode.
4. THE Bedrock_Auto_Ingestor SHALL include `developer_email` and `git_commit_hash` in the transmitted `IngestPayload`.
5. IF the Bedrock Auto-Ingest call fails (network error or non-2xx HTTP response), THEN THE CLI SHALL print the error detail and immediately terminate with a non-zero exit code without retrying silently.
6. IF the Bedrock_Auto_Ingestor itself fails to start or is unavailable (e.g., missing environment variables required by the Bedrock path), THEN THE CLI SHALL print a descriptive error message and terminate with a non-zero exit code.

---

### Requirement 5: Optional Override — `--results` Flag

**User Story:** As a CI/CD pipeline operator who already has a pre-built JSON results file, I want to supply it with `--results` to bypass the hierarchy entirely, so that I retain full control over what gets ingested.

#### Acceptance Criteria

1. WHEN the `--results <path>` flag (or a bare positional path) is supplied, THE CLI SHALL skip both the Marker Scan and the Bedrock Auto-Ingest phases and proceed directly to single-file ingestion using the supplied path.
2. WHEN the `--results` path resolves to a file that does not exist, THE CLI SHALL print an error and terminate with a non-zero exit code.
3. WHEN the `--results` path resolves to a file that cannot be parsed as valid JSON, THE CLI SHALL print the parse error detail and immediately terminate with a non-zero exit code; both the error print and the non-zero exit are mandatory and must succeed together.
4. THE `--results` flag SHALL remain mutually exclusive with `--dir`; supplying both SHALL cause the CLI to print an error and terminate with a non-zero exit code.
5. WHEN ingesting via `--results`, THE CLI SHALL include `developer_email` and `git_commit_hash` in the transmitted `IngestPayload`.

---

### Requirement 6: `--dir` Bulk Mode Preserved

**User Story:** As an operator ingesting many result files at once, I want the existing `--dir` bulk ingestion mode to continue working exactly as before, so that I am not affected by the new hierarchy changes.

#### Acceptance Criteria

1. THE CLI SHALL preserve all existing `--dir` bulk ingestion behaviour, including concurrent uploads, the `--concurrency` flag, and per-file error reporting.
2. WHEN `--dir` is supplied, THE CLI SHALL skip the Marker Scan and Bedrock Auto-Ingest phases; IF the CLI cannot confirm those phases were properly bypassed due to an internal control-flow error, it SHALL abort the operation and terminate with a non-zero exit code rather than proceeding with bulk ingestion.
3. WHEN `--dir` is supplied, THE CLI SHALL include `git_commit_hash` in every `IngestPayload` transmitted for each file in the directory.

---

### Requirement 7: API Key Validation and No-Auth-Bypass

**User Story:** As a security auditor, I want the CLI to always validate `OMNIS_API_KEY` regardless of ingestion mode, so that unauthenticated evidence is never submitted.

#### Acceptance Criteria

1. THE CLI SHALL read `OMNIS_API_KEY` from the environment before executing any ingestion path (Marker Scan, Bedrock Auto-Ingest, `--results`, or `--dir`).
2. IF `OMNIS_API_KEY` is absent from the environment OR is present but set to an empty string, THEN THE CLI SHALL print a descriptive error message and terminate with a non-zero exit code.
3. IF `OMNIS_API_KEY` does not begin with `omn_` or is shorter than 8 characters, THEN THE CLI SHALL print a format-validation error and terminate with a non-zero exit code.
4. THE CLI SHALL transmit `OMNIS_API_KEY` exclusively via the `Authorization: Bearer <key>` HTTP header; the key SHALL NOT be embedded in the JSON payload body or transmitted by any other means simultaneously.
5. THE CLI SHALL NOT bypass or mock the API key check under any code path, including fallback modes.

---

### Requirement 8: No Silent Failures and Graceful Degradation

**User Story:** As a regulated software operator, I want every failure in the CLI to surface loudly with actionable output, so that no evidence submission silently succeeds or fails without my knowledge.

#### Acceptance Criteria

1. WHEN the Marker Scan produces zero results, THE CLI SHALL emit a clearly labelled console warning (not a silent no-op) before activating the Bedrock fallback.
2. WHEN any ingestion HTTP call returns a non-2xx status, THE CLI SHALL print the HTTP status code and the server-provided error detail, then immediately terminate with a non-zero exit code without processing any further operations.
3. WHEN any file I/O operation (source scan, results file read) fails with a system error, THE CLI SHALL print the OS-level error message and the affected file path, then terminate with a non-zero exit code.
4. THE CLI SHALL NOT use `try/catch` blocks that swallow errors without printing them or without an explicit logged degradation step.
5. WHEN `git rev-parse HEAD` or `git config user.email` fails, THE CLI SHALL log a dim console notice stating which git command failed and what fallback value is being used, then continue without halting.

---

### Requirement 9: Scope Constraint — Single File Modification

**User Story:** As the project maintainer, I want the entire Smart Ingestion Hierarchy to be implemented exclusively within `omnis-cli/index.ts`, so that no other repository layer is unintentionally modified.

#### Acceptance Criteria

1. THE CLI implementation SHALL modify only `omnis-cli/index.ts` to deliver all Smart Ingestion Hierarchy behaviours.
2. THE implementation SHALL NOT modify any file under `omnis-api/`, `omnis-ui/`, or `omnis-run/`.
3. THE implementation SHALL NOT modify any Supabase migration file.
4. THE implementation SHALL NOT add new npm/bun package dependencies that require changes to `package.json` or `bun.lock` beyond the existing dependencies (`chalk`, `@types/bun`, `typescript`).
