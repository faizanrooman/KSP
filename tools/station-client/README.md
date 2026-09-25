# ksp-upload — station bulk evidence uploader

Command-line client for police-station upload terminals. It uploads body-worn / dash camera footage to
the KSP Video Evidence Management System through the same resumable, chunked upload API the web
uploader uses (`/api/v1/uploads`, see `docs/INGESTION.md`).

## What it does

* Logs in with your VMS account (password prompt, hidden; TOTP prompt if MFA is enabled) using bearer
  tokens, and refreshes the access token automatically during long transfers.
* Expands folders recursively and keeps only accepted video types (`.mp4 .mov .m4v .mkv .webm .avi .ts
  .mts .m2ts .3gp .wmv .asf .flv .mpg .mpeg`). Other files are listed as skipped.
* Computes the SHA-256 of each file before upload (the server re-hashes and quarantines on mismatch),
  and a SHA-256 per chunk (the server rejects a chunk corrupted in transit, and the client resends it).
* Uploads several files at a time and several chunks per file (`--files`, `--parts`), retrying
  transient failures with exponential backoff.
* Records progress in a local state file (`.ksp-upload-state.json`). If the run is interrupted (power,
  network), running the same command again resumes each file from the chunks the server already has, and
  skips files that were already uploaded.
* Waits for validation and prints a summary table with the evidence number of each registered item, or
  the quarantine reason.

## Usage

```bash
# from the monorepo (development)
npm run start -w @ksp/station-client -- --server https://vms.ksp.example --username op.cubbon \
    --station ps_cubbonpark --label "Night shift 24-09" /media/cam-dock/

# built (npm run build -w @ksp/station-client), with Node 22+
node tools/station-client/dist/cli.js --server … --username … --station … <files|folders…>
```

| Option | Meaning |
|---|---|
| `--server <url>` | VMS base URL |
| `--username <user>` | VMS username. Password from the prompt or `KSP_PASSWORD`; TOTP from the prompt or `KSP_TOTP` |
| `--station <code\|id>` | Station code (e.g. `ps_cubbonpark`) or org unit id. You need `evidence:upload` there |
| `--label <text>` | Batch label (default `<host> <date>`) |
| `--state <file>` | Resume state file (default `./.ksp-upload-state.json`) |
| `--files <n>` / `--parts <n>` | Parallel files / parallel chunks per file (default 3 / 3) |
| `--chunk-mib <n>` | Preferred chunk size (5–64 MiB). Smaller chunks suit unreliable links |
| `--officer <badge>` `--device <serial>` `--category <text>` | Defaults for every file |
| `--no-hash` | Skip the whole-file pre-hash (faster start; the server still hashes) |
| `--no-wait` / `--wait-timeout <sec>` | Don't wait for results / how long to wait (default 900 s) |

Exit codes: `0` everything uploaded (and registered, when waiting), `1` at least one file failed or was
quarantined, `2` usage, login or station error.

## Per-file metadata (sidecar)

Place a JSON file next to the video, named `<video>.json` (e.g. `clip.mp4.json`) or `<video-name>.json`
(`clip.json`):

```json
{
  "title": "MG Road patrol",
  "category": "PATROL",
  "officerBadge": "KSP-FO-1001",
  "deviceSerial": "AXON-B4-00042",
  "recordedAt": "2026-09-24T21:10:00+05:30",
  "incidentAt": "2026-09-24T21:25:00+05:30",
  "locationText": "MG Road metro exit",
  "latitude": 12.9756,
  "longitude": 77.6069,
  "notes": "Handed over by PC Ravi at 23:40"
}
```

Unknown keys are ignored. An unknown officer badge or device serial is rejected by the server before any
data is transferred (the file is reported as FAILED with the reason).

## Security notes

* Tokens are kept in memory only; the state file contains file paths, sizes and upload session ids —
  no credentials. Protect the upload terminal account as usual.
* The client never receives storage URLs; all data flows through the authenticated API.

## Tests

`npm test -w @ksp/station-client` starts the real API on an ephemeral port and the real ingest worker,
then drives the CLI against a test database (Postgres + S3 + FFmpeg must be running; see
`docs/CONTRACTS.md` §2).
