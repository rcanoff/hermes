---
name: companion-account-management
description: Use when the operator asks to create a companion app account, reset a companion password, list companion users, or revoke a pending invite. Calls companion MCP account tools only.
version: 1.1.0
author: Hermes Agent
---

# Companion Account Management

## Tools (companion MCP)

- `create_companion_invite` — optional `label`; returns `invite_id`, `token`, `expires_at`
- `create_password_reset_invite` — requires `username`; returns `invite_id`, `token`, `expires_at`
- `list_companion_accounts`
- `revoke_companion_invite` — requires `invite_id`

## Invite delivery (QR code)

Do **not** share magic links or redirect URLs. Invites are delivered as QR codes the Companion app scans.

After `create_companion_invite` or `create_password_reset_invite`:

1. Read the `token` from the MCP tool result.
2. Generate a QR code PNG:

```bash
python3 /opt/data/skills/companion-account-management/scripts/generate_invite_qr.py \
  --token "<token>"
```

3. Send the PNG to the operator so they can show it to the invitee.
4. Tell the invitee to open the Companion app, scan the QR code, and complete account setup or password reset.

The QR payload is the raw invite token. The app calls `GET /auth/invite/{token}` to determine whether it is activation or password reset.

## Rules

- Never truncate the token
- Never build or share `http://` invite URLs
- Accounts cannot be created except through these MCP tools
- For password reset, use the same QR flow as activation