# Raspberry Pi Ansible Deploy Design

**Date:** 2026-06-10  
**Status:** Implemented

## Goal

Add an Ansible project to this workspace so the local operator machine can deploy the Hermes workspace to an already-prepared Raspberry Pi at `rcanoff@raspberrypi5.local:/home/rcanoff/hermes` by pushing only changed files over SSH with `rsync`, then running the remote Docker Compose workflow there.

## Scope

This design covers deployment only:

- push changed workspace files from the local machine to the Raspberry Pi
- prepare the target deploy directory if it does not already exist
- run remote Docker Compose commands from the deployed workspace
- document the operator workflow for configuring and running the deployment

This design does not cover:

- Raspberry Pi bootstrap or package installation
- Docker installation or host hardening
- Git-based remote checkout workflows
- multi-host or clustered deployment
- release versioning or rollback orchestration

## Assumptions

- The Raspberry Pi is already reachable over SSH from this machine.
- The Raspberry Pi already has Docker Compose working.
- The deploy user and target directory are either already present or can be created with normal user permissions.
- The local machine is the source of truth for the workspace contents.
- The repo-local `.env` file is intended to be deployed to the Raspberry Pi as part of the workspace.

## Operator Requirements

The operator should be able to:

1. set the Raspberry Pi hostname/IP, SSH user, and remote deploy path in Ansible inventory variables
2. run one `ansible-playbook` command from this workspace
3. have only changed files transferred to the Raspberry Pi
4. have the remote Hermes deployment updated in place with Docker Compose

## Deployment Model

The deployment model is a single remote working directory on the Raspberry Pi:

```text
/home/rcanoff/hermes
```

The local machine pushes the workspace into that directory with `rsync` over SSH. After sync completes, Ansible runs the equivalent remote operational commands from that directory.

This is intentionally an in-place deployment model, not a release-directory model. It is simpler, matches the current workspace structure, and avoids adding version/rollback machinery that the user did not request.

## Proposed File Structure

The Ansible project should live under a new top-level `ansible/` directory:

- `ansible/ansible.cfg`
  - repo-local Ansible configuration
- `ansible/inventory/hosts.yml`
  - inventory with a `raspi` host group or single `hermes_raspi` host entry
- `ansible/inventory/group_vars/raspi.yml.example`
  - example variable file for remote user, host path, and compose behavior
- `ansible/deploy.yml`
  - main deployment playbook
- `ansible/files/rsync-excludes.txt`
  - explicit exclude list for runtime state and local-only artifacts

This structure keeps deployment-specific logic isolated from the Hermes runtime files while still living inside the same operations repo.

## Data and Secret Handling

The deployment should treat the local workspace as authoritative, including `.env`.

Rules:

- `.env` is deployed because the target stack needs it.
- `.env.example` remains tracked as documentation.
- `data/` should not be deployed from the local operator machine because it is runtime state owned by the target host.
- local caches and development artifacts should not be deployed.

The `rsync` exclude file should at minimum exclude:

- `.git/`
- `.pnpm-store/`
- `apple-caldav-mcp/node_modules/`
- `apple-caldav-mcp/dist/`
- `data/`
- `v11/`
- `hermes.zip`

The deploy should preserve the target host’s own `data/` directory and only update tracked operational files and source assets needed to run the stack.

## Playbook Flow

The deployment playbook should perform these phases in order:

### 1. Validate required variables

Required variables:

- remote host
- remote SSH user
- remote deploy path

Optional variables:

- SSH port
- Docker Compose command override if the Pi uses a different binary form

If required variables are missing, the playbook should fail early with clear messages.

### 2. Ensure target directory exists

Create the remote deploy directory if needed. This keeps the deployment idempotent and avoids relying on manual directory setup.

### 3. Push workspace diffs with rsync

Use `rsync` over SSH from the local machine to the remote deploy path.

Requirements:

- archive mode
- deletion enabled for files that were removed locally, limited to the deployed workspace
- explicit exclude file
- SSH transport using the configured user/host/port

This phase is responsible for “only the differences.”

### 4. Run remote Docker Compose update

From the remote deploy path, run:

1. token sync if needed by the remote shell path
2. `docker compose --env-file .env up -d`

The playbook should use the deployed workspace files directly and should not depend on WSL-specific wrappers.

### 5. Show resulting service state

Run a remote `docker compose ps` after deployment so the operator gets immediate confirmation about the stack state.

## Compose/Script Interaction

The current repo has local-machine wrapper logic for Windows and WSL, but the Raspberry Pi deployment should avoid those host-specific entrypoints.

Remote execution should call the Linux-native repo pieces:

- `scripts/sync-apple-calendar-mcp-token.sh`
- `docker compose --env-file .env ...`

This avoids pushing Windows-specific behavior into the Raspberry Pi deploy path.

## Error Handling

Failure behavior should be straightforward:

- fail before any remote action if inventory variables are incomplete
- fail on rsync transport errors
- fail on remote compose errors
- always surface the exact failing command/task in Ansible output

No rollback behavior is required in this version. The workspace is updated in place, and failure diagnosis should be done from Ansible output plus remote Docker logs.

## Testing and Verification

The implementation should include operator-level verification, not unit tests.

Required checks:

1. Ansible inventory parses successfully
2. the playbook passes `--syntax-check`
3. a dry-run path exists via `--check` for non-rsync tasks where Ansible supports it
4. a real deploy path is documented
5. remote `docker compose ps` output is shown at the end of a successful run

Because `rsync` and remote Docker execution are integration behavior, the main confidence comes from syntax checks plus a real deployment run.

## Recommended Operator Workflow

1. copy the example group vars file into a real inventory vars file or edit the inventory directly
2. set:
   - Raspberry Pi host or IP
   - SSH user
   - remote deploy path
3. optionally verify connectivity with `ansible -i inventory/hosts.yml raspi -m ping`
4. run:

```bash
ansible-playbook -i ansible/inventory/hosts.yml ansible/deploy.yml
```

5. inspect the reported `docker compose ps` output

## Design Tradeoffs

### Why rsync over SSH

- matches the user’s requirement exactly
- efficient for incremental updates
- simple operational model
- no dependency on a remote Git checkout

### Why not release bundles

- heavier than needed
- not diff-based
- adds packaging and extraction complexity

### Why not deploy `data/`

- `data/` is target runtime state
- overwriting it from the operator machine is risky
- the repo’s own instructions already treat `data/` as persisted runtime state, not hand-maintained source

## Success Criteria

This design is successful when:

- the repo contains an Ansible deployment project under `ansible/`
- the operator can configure one Raspberry Pi target
- running one playbook from the local machine syncs changed files to the Pi
- the remote Hermes stack is updated with Docker Compose
- the workflow is documented in the README
