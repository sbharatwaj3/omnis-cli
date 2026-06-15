# omnis-cli

**Ships signed test evidence to the Omnis RegOps platform.**

This is the developer-facing CLI tool for the Omnis Evidence Mesh. It reads a local JSON results file and POSTs it to the `/api/ingest` endpoint on Vercel, authenticated via an org-scoped API key.

> This is a **separate ingestion path** from `omnis-run` (the Go subprocess wrapper). Use this CLI when you have already captured test results as a JSON file and want to submit them directly.

---

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- An **Omnis API Key** generated in your dashboard under **Settings → API Keys**

---

## Setup

```bash
cd omnis-cli
bun install
cp .env.example .env
# Edit .env and set OMNIS_API_KEY=omn_<your_key>
```

---

## Usage

```bash
# Basic — send a results file
bun run index.ts --results ./test-output.json

# With regulatory tagging and build version
bun run index.ts \
  --results ./test-output.json \
  --req-id "FDA-820.30g" \
  --build "v1.2.3" \
  --status PASS

# Point at a non-default .env file (useful in CI/CD)
bun run index.ts --results ./results/pytest.json --env-file /secrets/.env.omnis

# Full help
bun run index.ts --help
```

### Options

| Flag | Description | Required |
|---|---|---|
| `--results <path>` | Path to a JSON file containing test results | ✅ |
| `--req-id <id>` | Regulatory rule ID, e.g. `FDA-820.30g` | No |
| `--build <version>` | Build/version string, e.g. `v1.2.3` | No |
| `--status <PASS\|FAIL>` | Execution status override (default: `PASS`) | No |
| `--endpoint <url>` | Override the default Vercel endpoint | No |
| `--env-file <path>` | Path to a `.env` file (default: `./.env`) | No |
| `--help` | Show help and exit | No |

---

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `OMNIS_API_KEY` | Your org API key (must start with `omn_`) | ✅ |
| `OMNIS_API_ENDPOINT` | Override the target endpoint URL | No |

---

## Results File Format

The `--results` file can be any valid JSON object or array. A typical pytest JSON output works directly:

```json
{
  "summary": { "passed": 12, "failed": 0, "warnings": 1 },
  "tests": [
    { "name": "test_cgm_alert_threshold", "outcome": "passed", "duration": 0.043 }
  ]
}
```

---

## Authentication Model

Your API key is sent as `Authorization: Bearer omn_<key>`.

The server verifies it by:
1. Scanning `organization_api_keys` for a row whose salted SHA-256 hash matches your key
2. Resolving the `org_id` from that row — **never trusting org identity from the payload**
3. Stamping the evidence log with the correct org, build, and regulatory rule

The raw key is **never stored** on the server.

---

## Relationship to omnis-run

| | `omnis-run` (Go) | `omnis-cli` (this tool) |
|---|---|---|
| Auth | Supabase JWT + HMAC-SHA256 | API key (`omn_`) |
| Endpoint | FastAPI `/api/v1/evidence/ingest` | Next.js `/api/ingest` |
| Use case | Wraps live subprocess execution | Submits pre-captured JSON results |
| AI processing | Yes (Bedrock, background) | Via Supabase write |
