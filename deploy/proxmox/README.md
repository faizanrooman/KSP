# Demo deployment on a Proxmox VE host

Target: a Proxmox host (e.g. `https://192.168.1.50:8006`) with an existing reverse‑proxy container. The application
runs in its own unprivileged Debian 12 LXC with Docker (compose stack from `deploy/compose`), and the reverse proxy
terminates TLS for the name users open. Everything below is copy‑paste; nothing requires access from a developer
machine.

## 1. Create the container and install (on the Proxmox host shell, as root)

```bash
git clone https://github.com/rooman-itsd/KSP.git /root/ksp-src        # only the deploy scripts are needed
bash /root/ksp-src/deploy/proxmox/pve-create-lxc.sh --hostname ksp-vms --fqdn ksp.lan \
     --ip 192.168.1.60/24,gw=192.168.1.1          # or --ip dhcp
#   --ghcr-token <GitHub PAT with read:packages>  pulls the images built by the release workflow (fast)
#   (without it the images are built from source inside the container — 10–20 min on first run)
#   --no-ai                                       skip the AI worker and the ~300 MB model download
```

Sizing for a demo: 4 vCPU, 8 GB RAM, 80 GB disk (`--cores/--memory/--disk`). The script downloads the Debian 12
template, creates the CT with `nesting=1,keyctl=1` (required for Docker in an unprivileged LXC), pushes
`install-in-lxc.sh` and runs it: Docker, repository, secrets (`scripts/ops/generate-secrets.sh`), `.env` for the
**demo tier**, migrations, demo seed data, application services, AI models. It prints the container IP; the web tier
listens on `http://<ip>:8080` **inside the LAN only** — never publish it directly.

Already have a Docker‑capable container/VM (for example the reverse‑proxy container itself)? Run
`install-in-lxc.sh --fqdn ksp.lan` in it instead; the stack then binds `127.0.0.1:8080`‑style on that host — set
`WEB_BIND` in `deploy/compose/.env` accordingly.

## 2. Reverse proxy (TLS is mandatory)

The application issues secure cookies and validates `APP_BASE_URL` is `https://…`, so the proxy must serve HTTPS.
A self‑signed or internal‑CA certificate is fine for the demo (browsers show a one‑time warning).

**nginx container**: copy `reverse-proxy-nginx.conf` to `/etc/nginx/conf.d/ksp.conf`, set `server_name` and the
upstream IP, create the certificate (command in the file), `nginx -s reload`.

**Nginx Proxy Manager**: Hosts → Proxy Hosts → Add: domain `ksp.lan`, scheme `http`, forward host `<container ip>`,
port `8080`, *Block common exploits* on, *Websockets* off; SSL tab → request/select a certificate, *Force SSL*,
*HTTP/2*; Advanced → paste:

```
client_max_body_size 64m;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_request_buffering off;
proxy_buffering off;
```

Resolve the name: LAN DNS entry `ksp.lan → <proxy ip>`, or a hosts‑file line on the demo laptop.

## 3. Open it

`https://ksp.lan` → sign in with the demo accounts (password for all `Ksp@Dev-Passw0rd!`): `admin` (system
administrator; enrols an authenticator app on first sign‑in — scan the QR with Google/Microsoft Authenticator),
`io.meera` (investigating officer, Cubbon Park PS), `sup.kavya` (supervisor), `fo.ravi`, `op.cubbon`, `fa.naveen`,
`ec.latha`, `aud.suresh`. Full list: `docs/CONTRACTS.md` §2.

## Operating the demo

```bash
pct enter <ctid>; cd /opt/ksp
C="docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env"
$C ps                          # status            $C logs -f api worker        # logs
$C --profile ai ps             # AI worker         $C restart api worker web
git pull && $C pull && $C run --rm migrate && $C up -d        # update to the latest main (images from GHCR)
```

What the demo tier changes versus production (`deploy/compose/.env`): `KSP_ENVIRONMENT=demo`, `KSP_PREFLIGHT=warn`
(the production preflight logs its findings — self‑signed signing key stamped *NON‑EVIDENTIARY*, GOVERNANCE object
lock, bundled S3 gateway, demo users — instead of refusing to start), `KSP_ALLOW_NONEVIDENTIARY_SIGNING=true`,
`DATABASE_TLS_WAIVED=true`. For production follow `docs/GO-LIVE-CHECKLIST.md` (HSM key, COMPLIANCE lock, real S3,
`ops:purge-demo-data`, `KSP_ENVIRONMENT=production`).

AI: every analytic is installed (`AI_TASKS_ENABLED=all`) and the legal gates are **enforced** as in production
(`AI_LEGAL_GATES=enforce`): face detection, face recognition (watchlists and face search) and number-plate recognition
stay disabled until an administrator records the approval in **Settings → Legal approvals**. The installer sets the
value on every run (installers before 2026-10-10 wrote `off`). To demonstrate those analytics without an approval,
re-run the installer with `--ai-legal-gates off` (put `KSP_INSTALL_ARGS="--ai-legal-gates off"` in
`/etc/ksp-autodeploy.env` when auto-deploy is enabled); Settings then marks each one **Not enforced**.

The bundled S3 gateway (versitygw) gets the application and AI identities created in its IAM store by the installer
(both with the `admin` role — a production S3 store restricts the AI identity to the derived bucket by policy,
`deploy/s3/policies/`).

Resources: Postgres and the S3 gateway keep their data in Docker volumes (`pgdata`, `s3data`); back the CT up with
Proxmox backups (`vzdump`) in addition to the application's own encrypted backups (`backup` profile).

Application backups: the installer installs the systemd timer **`ksp-backup.timer`** (nightly 01:30 IST) that runs the
encrypted database backup (`docker compose --profile ops run --rm backup` → `scripts/backup/pg-backup.sh`: dump, age
encryption, signed manifest, Object-Lock upload to `BACKUP_S3_BUCKET`), and starts a first run when no backup has
succeeded in the last 26 h. Every run is recorded in `backup_runs` and shown under **System health → Backups** (last
successful run, size, the ten most recent runs with errors). In this demo the backup bucket lives in the bundled S3
gateway; production writes it to a separate site (`docs/BACKUP-RESTORE-RUNBOOK.md`). Check a run by hand:
`systemctl start ksp-backup.service && journalctl -u ksp-backup -n 30`; schedule: `systemctl list-timers ksp-backup.timer`.
The weekly restore test (`scripts/backup/verify-backup.sh`) needs the decryption identity, which is kept offline, so it
is not scheduled on the demo host.

## Automatic deployment (push to `main` → live after CI passes)

Inside the container, once:

```bash
cd /opt/ksp && git pull -q && bash deploy/proxmox/enable-autodeploy.sh --fqdn ksp.futureacad.ae
```

A systemd timer (`ksp-autodeploy.timer`, every 5 min) fetches `main`; for a new commit it asks the GitHub API whether
the **`ci` workflow passed for exactly that commit**. Still running → it waits; failed/cancelled → that commit is
skipped and the current version stays live; passed → it checks out that commit and runs
`install-in-lxc.sh --skip-git` (rebuilds only changed images, applies migrations, restarts changed services), then
waits until the web tier and both API replicas are healthy before recording it as deployed.

Pull-based by design: GitHub never connects to the server (no inbound SSH, no self-hosted runner that pull requests
from forks could run code on). Demo data is seeded only on an empty database, so automatic updates never re-create
users you deleted or reset passwords.

```bash
systemctl list-timers ksp-autodeploy.timer         # next check
journalctl -u ksp-autodeploy -n 50 -f              # what it did
cat /var/lib/ksp-autodeploy/history.tsv            # deployed commits (start, end, sha)
systemctl start ksp-autodeploy                     # check/deploy now
bash deploy/proxmox/enable-autodeploy.sh --disable # turn off
```
\n
## Demo content

A fresh install has the organisation, the demo users and no evidence. To load a realistic demo data set:

```bash
cd /opt/ksp && git pull -q && bash deploy/proxmox/load-demo-content.sh
```

10 body‑worn‑camera style videos (camera/officer overlay, running IST clock, GPS) uploaded through the real pipeline
by `io.meera`, `fo.ravi`, `op.cubbon` (Cubbon Park), `io.arjun` (Indiranagar) and `io.mysuru` (Nazarbad, Mysuru) —
GPS taken from the file, declared at upload, or the station fallback; 6 demo cameras; FIRs 0412/2026 and 0377/2026
with cases, linked evidence and case diary; AI analyses (number plates, persons, faces, objects) waiting in the review
queue; an investigation workspace with bookmarks; a court export waiting for `sup.kavya` to approve. Re-running is a
no-op (`--force` loads another copy; `--password` if the demo password was changed). The demo seed re-creates demo users
that were deleted — use it on demo systems only.
