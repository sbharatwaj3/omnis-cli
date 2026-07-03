# Implementation Plan: Smart Ingestion Hierarchy

## Overview

Refactor `omnis-cli/index.ts` to implement a three-tier priority-ordered ingestion strategy (Marker Scan → Bedrock Auto-Ingest → `--results` override), add a mandatory build-check gate, thread `git_commit_hash` through every payload, and cover all correctness properties in `index.test.ts`.

**Scope constraint:** Only `omnis-cli/index.ts` and `omnis-cli/index.test.ts` may be created or modified. No new packages may be added to `package.json` or `bun.lock`. Property-based tests use Bun's built-in test runner with manual iteration loops (fast-check is not available in this package).

---

## Tasks

- [x] 1. Update `CliArgs` and `IngestPayload` interfaces
  - Add `srcDir: string` (default `"."`) to `CliArgs`; make `resultsPath` explicitly `string | undefined`
  - Add `git_commit_hash: string | null` to `IngestPayload`
  - Export both interfaces with `/* @internal */` JSDoc tags for test visibility
  - _Requirements: 2.4, 3.1, 5.1, 6.3, 9.1_

- [x] 2. Implement `resolveGitCommitHash()` and `runBuildCheck()`
  - [x] 2.1 Implement `resolveGitCommitHash(): string`
    - Call `spawnSync("git", ["rev-parse", "HEAD"])` with `timeout: 3_000` and `windowsHide: true`
    - On success (exit 0, non-empty stdout): return `stdout.trim()`
    - On any failure, empty output, or thrown error: log dim notice and return `"unknown_commit"`
    - Export with `/* @internal */` tag
    - _Requirements: 2.1, 2.2, 2.3, 8.5_

  - [x] 2.2 Write property test for `resolveGitCommitHash()` — Property 4
    - **Property 4: Git Hash Whitespace Trimming**
    - **Validates: Requirements 2.2**
    - Use a manual loop (100 iterations) generating random strings with leading/trailing whitespace; mock `spawnSync` to return exit 0 with that string; assert result equals `input.trim()`

  - [x] 2.3 Implement `runBuildCheck(): void`
    - Call `spawnSync("bun", ["run", "typecheck"])` with `timeout: 60_000`, `encoding: "utf8"`, `windowsHide: true`
    - Combine stdout + stderr; if `combined.length === 0` → HALT AND CATCH FIRE via `fatal()`
    - If `result.status !== 0` → print combined output then `fatal()`
    - If exit 0 and `combined.length >= 1` → log dim pass message and return normally
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.4 Write property test for `runBuildCheck()` — Properties 2 and 3
    - **Property 2: Non-Zero Build Exit Always Terminates CLI Non-Zero**
    - **Property 3: Successful Build Check Allows Continuation**
    - **Validates: Requirements 1.2, 1.4**
    - Manual loop generating non-zero exit codes; assert `fatal()` is called with combined output printed
    - Separate loop for exit-0 + non-empty output; assert function returns without calling `process.exit`

- [x] 3. Implement `scanForMarkers(srcDir: string): string[]`
  - Resolve `srcDir` to absolute path; call `fatal()` if `!existsSync(absDir)`
  - Recursively walk with `readdirSync(..., { withFileTypes: true })`; visit only `.py`, `.ts`, `.js` files
  - Apply `/\@pytest\.mark\.requirement\(\s*["']([^"']+)["']\s*\)/g` for `.py` files
  - Apply `/\/\/\s*@req:\s*(\S+)/g` for `.ts` and `.js` files; reset `lastIndex` before each file
  - Collect all matches into a `Set<string>` and return `Array.from(found)`
  - Export with `/* @internal */` tag
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 8.3_

  - [x] 3.1 Write property test for `scanForMarkers()` — Properties 6, 7, 8, 9
    - **Property 6: Marker Scanner Finds All Annotated Files**
    - **Property 7: Python Annotation Extraction**
    - **Property 8: JS/TS Annotation Extraction**
    - **Property 9: Deduplication Preserves All Unique IDs**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
    - Extract and export `extractMarkersFromContent(content: string, ext: string): string[]` as a pure helper from `scanForMarkers`; test it directly with generated content strings
    - Manual loops generating arrays of random `Req_ID` strings (no `"`, `'`, or whitespace); verify all IDs present, no duplicates, no wrong-extension matches

- [x] 4. Refactor `parseArgs()` — make `--results` optional, add `--src-dir`
  - Remove the `fatal()` branch that requires `resultsPath || dirPath`
  - Add `--src-dir <path>` flag; default to `"."`
  - Retain mutual exclusion: `--results` + `--dir` together still `fatal()`
  - Return `srcDir` in the `CliArgs` object
  - _Requirements: 3.1, 5.1, 5.4, 6.1, 9.1_

  - [x] 4.1 Write unit tests for `parseArgs()` refactor
    - Test: no `--results` and no `--dir` returns without fatal (hierarchy mode)
    - Test: `--results` + `--dir` together calls `fatal()`
    - Test: `--src-dir ./src` is parsed into `srcDir`
    - Test: omitting `--src-dir` defaults `srcDir` to `"."`
    - _Requirements: 5.4, 3.1_

- [x] 5. Implement `runBedrockFallback(...)` and `runMarkerScan(...)`
  - [x] 5.1 Implement `runBedrockFallback(endpoint, apiKey, developerEmail, gitCommitHash): Promise<void>`
    - Print yellow warning: `"[omnis] No requirement markers found. Activating Bedrock Auto-Ingest fallback."`
    - Build `IngestPayload` with `results: null`, `execution_status: "BEDROCK_AUTO_INGEST"`, `developer_email`, `git_commit_hash`
    - Call `await transmit(endpoint, apiKey, payload)` — `transmit` already calls `fatal()` on non-2xx
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 8.1_

  - [x] 5.2 Implement `runMarkerScan(srcDir, endpoint, apiKey, executionStatus, developerEmail, gitCommitHash): Promise<boolean>`
    - Call `scanForMarkers(srcDir)`
    - If `markers.length === 0`: emit `console.warn` with labelled message and return `false`
    - Determine test runner from annotated-file extensions (`.py` → pytest; `.ts`/`.js` → bun test; mixed → both sequentially); run via `spawnSync`, capture combined output
    - Build `IngestPayload` with captured output as `results`, `developer_email`, `git_commit_hash`; include `execution_status` if set
    - Call `await transmit(endpoint, apiKey, payload)` and return `true`
    - _Requirements: 3.4, 3.5, 3.6, 4.1, 8.1, 8.2_

  - [x] 5.3 Write unit tests for `runBedrockFallback()` and `runMarkerScan()`
    - Test: `runBedrockFallback` payload contains `execution_status: "BEDROCK_AUTO_INGEST"`, correct `git_commit_hash`
    - Test: `runMarkerScan` with 0 markers emits `console.warn` and returns `false` without calling `transmit`
    - Test: `runMarkerScan` with markers calls `transmit` with payload containing `git_commit_hash` and returns `true`
    - _Requirements: 3.5, 4.2, 4.3, 4.4, 8.1_

- [x] 6. Update `runBulk()` — add `gitCommitHash` parameter
  - Add `gitCommitHash: string` as the last parameter
  - Thread `git_commit_hash: gitCommitHash` into every per-file `IngestPayload` construction inside the task map
  - Update the call site in `run()` once it is refactored in the next task
  - _Requirements: 6.1, 6.3_

  - [x] 6.1 Write unit test for `runBulk()` git hash threading
    - Mock `transmitOne`; supply two `.json` files in a temp directory
    - Assert every captured payload passed to `transmitOne` contains the expected `git_commit_hash` value
    - _Requirements: 6.3_

- [x] 7. Refactor `run()` — wire the full hierarchy
  - Call `runBuildCheck()` immediately after `parseArgs()` + `loadEnvFile()`, before any identity resolution or API-key check
  - Call `resolveGitCommitHash()` after `resolveDeveloperEmail()`; store result in `const gitCommitHash`
  - Pass `gitCommitHash` explicitly to `runBulk`, single-file ingest, `runMarkerScan`, and `runBedrockFallback`; never store in a module-level mutable
  - Single-file path: add `git_commit_hash: gitCommitHash` to the `IngestPayload` object
  - Hierarchy branch: `const markerHit = await runMarkerScan(...)`; if `!markerHit` call `await runBedrockFallback(...)`
  - `--dir` and `--results` modes bypass hierarchy entirely
  - _Requirements: 1.1, 2.5, 5.1, 5.5, 6.2, 7.1, 7.5_

  - [x] 7.1 Write property test for `run()` build-check ordering — Property 1
    - **Property 1: Build Check Always Precedes Ingestion**
    - **Validates: Requirements 1.1**
    - Mock `runBuildCheck`, `transmit`, `runBulk`, `runMarkerScan`, `runBedrockFallback` with call-order tracking
    - For each of the three CLI modes (hierarchy, `--results`, `--dir`), assert `runBuildCheck` call index is 0

  - [x] 7.2 Write property test for `git_commit_hash` presence — Property 5
    - **Property 5: Git Commit Hash Present in Every Payload**
    - **Validates: Requirements 2.5, 3.5, 4.4, 5.5, 6.3**
    - Intercept all calls to `transmit` and `transmitOne`; for each of the four ingestion paths, assert every captured payload has `git_commit_hash !== undefined`

- [x] 8. Update `printHelp()` — reflect new flags and modes
  - Add `--src-dir <path>` to the OPTIONS block with description and default
  - Remove the `(required if no flags)` annotation from `<path>` / `--results`; add note about hierarchy mode
  - Add a MODES section describing the three-tier hierarchy, Bedrock fallback, and `--results` override
  - _Requirements: 9.1_

- [x] 9. Checkpoint — ensure all tests pass
  - Run `bun test index.test.ts --run` and confirm zero failures
  - Run `bun run typecheck` and confirm exit 0 with non-empty output
  - Verify `bun run typecheck` does not produce 0 bytes (HALT AND CATCH FIRE guard)
  - Ask the user if any questions arise before proceeding.

- [x] 10. Write remaining property and unit tests in `index.test.ts`
  - [x] 10.1 Write property test for `--results` bypass — Property 10
    - **Property 10: `--results` Flag Bypasses Hierarchy**
    - **Validates: Requirements 5.1**
    - Assert `scanForMarkers` and `runBedrockFallback` are never called when `--results` is supplied

  - [x] 10.2 Write property test for invalid JSON fatal exit — Property 11
    - **Property 11: Invalid JSON Files Always Cause Fatal Exit**
    - **Validates: Requirements 5.3**
    - Manual loop generating strings that fail `JSON.parse`; assert `fatal()` is called and process exits non-zero

  - [x] 10.3 Write property test for `--dir` bypass — Property 12
    - **Property 12: `--dir` Mode Bypasses Hierarchy**
    - **Validates: Requirements 6.2**
    - Assert `scanForMarkers` and `runBedrockFallback` are never called when `--dir` is supplied

  - [x] 10.4 Write property test for API key format validation — Property 13
    - **Property 13: API Key Format Validation**
    - **Validates: Requirements 7.3**
    - Export `validateApiKey(key: string): void`; manual loop generating keys that lack `omn_` prefix or are shorter than 8 chars; assert every call throws / calls `fatal()`

  - [x] 10.5 Write property test for API key not in payload — Property 14
    - **Property 14: API Key Never Appears in Payload Body**
    - **Validates: Requirements 7.4**
    - Intercept `fetch`; for generated API key strings, assert `JSON.stringify(payload)` does not contain the key value and the `Authorization` header is `Bearer <key>`

  - [x] 10.6 Write property test for non-2xx fatal exit — Property 15
    - **Property 15: Non-2xx HTTP Responses Always Cause Fatal Exit**
    - **Validates: Requirements 4.5, 8.2**
    - Mock `fetch` to return status codes outside 200–299; assert `fatal()` is called with status code in message

  - [x] 10.7 Write property test for file I/O error surfacing — Property 16
    - **Property 16: File I/O Errors Surface Path and Message**
    - **Validates: Requirements 8.3**
    - Mock `readFileSync` to throw OS errors with synthetic paths; assert error message and file path both appear in the `fatal()` call

  - [x] 10.8 Write unit tests for edge cases
    - HALT AND CATCH FIRE: mock `spawnSync` to return 0 bytes combined; assert `fatal()` message contains "zero bytes" / "ambiguous failure"
    - `unknown_commit` fallback: three sub-cases — non-zero exit, empty stdout, spawnSync throws; each must log dim notice and return `"unknown_commit"`
    - Zero-marker warning path: `scanForMarkers` returns `[]`; verify `console.warn` fires and `runBedrockFallback` is called, not `transmit` directly
    - Non-existent `--src-dir`: verify `fatal()` is called containing the resolved path
    - Non-existent `--results` path: verify `fatal()` is called
    - Missing `OMNIS_API_KEY` and empty string: verify `fatal()` with setup message
    - `--results` + `--dir` mutual exclusion: verify `fatal()` is called
    - _Requirements: 1.3, 2.3, 3.6, 3.8, 5.2, 5.4, 7.2, 8.1_

- [x] 11. Final checkpoint — typecheck and full test suite
  - Run `bun run typecheck` and confirm non-zero-byte, exit-0 output
  - Run `bun test index.test.ts --run` and confirm all tests pass
  - Confirm no files outside `omnis-cli/index.ts` and `omnis-cli/index.test.ts` were modified
  - Ask the user if any questions arise.

---

## Notes

- Tasks marked with `*` are optional and may be skipped for a faster MVP delivery
- `fast-check` is not available in `omnis-cli` — property tests use manual 100-iteration `for` loops with `Math.random`-seeded or hand-crafted generators; Bun's `describe`/`it`/`expect` API is the only test framework used
- `git_commit_hash` is resolved once in `run()` and threaded via explicit parameters — it is never stored in a module-level mutable variable
- `extractMarkersFromContent(content, ext)` must be extracted as a pure, exported helper to make Properties 7, 8, and 9 unit-testable without touching the filesystem
- `validateApiKey(key)` must be extracted as a pure, exported helper to make Property 13 testable in isolation
- All `spawnSync` calls use `windowsHide: true` to suppress console windows on Windows
- The HALT AND CATCH FIRE protocol (0 bytes from typecheck) is a hard fatal — it must fire before any other exit-code check in `runBuildCheck()`
- Checkpoints are hard stops: do not proceed past task 9 or task 11 without a clean `bun run typecheck` result

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1", "4"] },
    { "id": 3, "tasks": ["4.1", "5.1", "5.2", "6"] },
    { "id": 4, "tasks": ["5.3", "6.1", "7"] },
    { "id": 5, "tasks": ["7.1", "7.2", "8"] },
    { "id": 6, "tasks": ["10.1", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "10.8"] }
  ]
}
```
