Goal: create a portable Docker Compose setup for Hermes Agent.
Test first on macOS, then deploy unchanged to Raspberry Pi 5 8GB with SSD.

Requirements:
- Use Docker Compose.
- Use official Hermes Agent Docker image if available: nousresearch/hermes-agent.
- Persist all Hermes data outside the image.
- Use ./data on macOS and /srv/hermes/data on Raspberry Pi.
- Container path must remain /opt/data.
- Include dashboard container if supported.
- Avoid exposing dashboard publicly; bind it to localhost.
- Prefer pinned image tag over latest.
- Confirm linux/arm64 image support before Raspberry Pi deployment.

Reference facts:
- Official compose maps host storage to /opt/data.
- Hermes image declares HERMES_HOME=/opt/data and VOLUME /opt/data.
- Official compose uses command ["gateway", "run"].
- Official dashboard command uses ["dashboard", "--host", "127.0.0.1", "--no-open"].

Deliverables:
1. docker-compose.yml
2. .env.example
3. README.md with:
   - macOS test steps
   - Raspberry Pi deployment steps
   - backup/restore commands
   - update procedure
   - troubleshooting commands

Architecture:
- Service: hermes-gateway
- Optional service: hermes-dashboard
- Volume mapping: ./data:/opt/data
- Restart policy: unless-stopped
- Network: start with host networking only if required by official compose; otherwise prefer explicit ports.
- UID/GID support:
  HERMES_UID=${HERMES_UID:-10000}
  HERMES_GID=${HERMES_GID:-10000}

Backup:
- Stop containers.
- Archive compose.yml, .env, and data/.
- Restore by extracting the archive and running docker compose up -d.

Deployment phases:
1. Validate on macOS.
2. Confirm data persists after restart/recreate.
3. Confirm arm64 image support.
4. Copy project directory to /srv/hermes on Raspberry Pi SSD.
5. Run with correct HERMES_UID/HERMES_GID.
6. Verify logs, dashboard, and persistence.
