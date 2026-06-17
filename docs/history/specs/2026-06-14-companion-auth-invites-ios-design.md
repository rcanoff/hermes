# Companion Auth — iOS Design Spec

**Date:** 2026-06-14  
**Status:** Approved  
**Parent:** `docs/history/specs/2026-06-14-companion-auth-invites-design.md`  
**Backend spec:** `docs/history/specs/2026-06-14-companion-auth-invites-backend-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v1.6.0)

**Codebase location:** separate machine — paths are relative to the `assistant-companion` Xcode project root.

**Prerequisite:** Base app per `docs/history/implemented/plans/2026-06-12-assistant-companion-plan.md` (login, Keychain, conversations, chat). Backend v1.6.0 deployed before live testing.

---

## Goal

Replace pre-provisioned-credentials login with **magic-link onboarding** and **operator-initiated password reset**, consuming the v1.6.0 invite auth routes.

No self-registration UI. Returning users continue to use username + password.

---

## Out of Scope (v1)

- In-app "forgot password" (operator issues reset link via Hermes)
- Account management UI (Hermes-only)
- QR code scanning for invites
- Backend / MCP implementation (see backend spec)

---

## User Flows

### Activation (new user)

1. User receives magic link: `http://<host>/invite/<token>`
2. Link opens the app (universal link or custom URL scheme fallback)
3. App calls `GET /auth/invite/{token}`
4. On `valid: true, type: activation` → `ActivateAccountView`
5. User enters **username**, **password**, **confirm password**
6. App calls `POST /auth/activate` with `{ token, username, password }`
7. On success: store JWT in Keychain → `ConversationListView`

### Password reset

1. User receives reset link (same URL shape)
2. App calls `GET /auth/invite/{token}`
3. On `valid: true, type: password_reset` → `ResetPasswordView`
4. User enters **password** + **confirm** (no username)
5. App calls `POST /auth/reset-password` with `{ token, password }`
6. On success: store JWT in Keychain → `ConversationListView`

### Returning user

Unchanged: `LoginView` → `POST /auth/login` → Keychain → `ConversationListView`

### Invalid / expired link

Show `InviteErrorView`: "This link has expired or is no longer valid. Contact the operator."

`reason` mapping:

| `reason` | User message |
|----------|--------------|
| `expired` | Link has expired |
| `used` | Link already used |
| `revoked` | Link was cancelled |
| `not_found` | Link not found |

---

## Deep Link Handling

### Primary: universal link

Register associated domain for `http://<MESSAGING_API_HOST>/invite/*`.

The backend `GET /invite/{token}` landing route may redirect to the custom scheme if the app is not installed.

### Fallback: custom URL scheme

`hermes-companion://invite/{token}`

Handle in `App` / `SceneDelegate` / `onOpenURL`.

### Token extraction

Parse final path segment after `/invite/`. Reject malformed URLs before API call.

### Navigation

```
RootView
  ├─ LoginView                    (no token in Keychain)
  ├─ ConversationListView         (valid token in Keychain)
  ├─ ActivateAccountView          (deep link, type: activation)
  ├─ ResetPasswordView            (deep link, type: password_reset)
  └─ InviteErrorView              (invalid invite)
```

On cold start with Keychain token: validate via `GET /auth/me` before skipping login (unchanged pattern).

On deep link while logged in: complete invite flow, replace stored JWT with new one.

---

## API Client Changes

Add to `APIClient` (or `AuthService`):

| Method | Route | Notes |
|--------|-------|-------|
| `getInvite(token:)` | `GET /auth/invite/{token}` | No auth header |
| `activate(token:username:password:)` | `POST /auth/activate` | Returns JWT |
| `resetPassword(token:password:)` | `POST /auth/reset-password` | Returns JWT |

### Client-side validation (before network)

- Username: non-empty, trimmed, allowed charset (match server: alphanumeric + `_` `-`, 3–32 chars — confirm in backend implementation)
- Password: min 12 chars, confirmation must match
- Show server errors: `username_taken`, `weak_password`, `invalid_token`

---

## Views

### `ActivateAccountView`

- Fields: username, password, confirm password
- Submit → `activate(...)` → Keychain → navigate to conversations
- Loading + error states

### `ResetPasswordView`

- Fields: password, confirm password
- Submit → `resetPassword(...)` → Keychain → navigate to conversations

### `InviteErrorView`

- Static message + optional reason detail
- Button: "Back to Login"

### `LoginView`

- Unchanged layout
- No "Sign up" or "Forgot password" links (operator-mediated only)

---

## Keychain

Unchanged `KeychainService` wrapper. After activate/reset success, store JWT the same way as login.

On `401` from `GET /auth/me` (e.g. after server-side password reset on another device): clear Keychain, show `LoginView`.

---

## File Targets

```
assistant-companion/assistant-companion/
  Services/
    APIClient.swift                 — invite + activate + reset methods
    AuthService.swift               — optional: wrap auth calls
    KeychainService.swift           — unchanged
  ViewModels/
    AuthViewModel.swift             — add invite flow state
    ActivateAccountViewModel.swift  — NEW
    ResetPasswordViewModel.swift    — NEW
  Views/
    LoginView.swift                 — unchanged
    ActivateAccountView.swift       — NEW
    ResetPasswordView.swift         — NEW
    InviteErrorView.swift           — NEW
    RootView.swift                  — deep link routing
  App/
    assistant_companionApp.swift    — onOpenURL / universal link
  Info.plist                        — URL types + associated domains
  assistant-companion.entitlements  — associated domains

assistant-companionTests/
  InviteURLParserTests.swift        — NEW
  ActivateAccountViewModelTests.swift — NEW (mock API)
```

---

## Testing

### Unit

- URL parsing: valid token, missing token, encoded characters
- ViewModel: successful activate, `username_taken`, `weak_password`, `invalid_token`
- ViewModel: successful reset, password mismatch client-side

### Manual (requires backend v1.6.0 on VPN)

1. Hermes creates invite → open link on device → complete activation
2. Log out → log in with chosen credentials
3. Hermes creates reset invite → open link → set new password
4. Old JWT rejected; new login works
5. Expired / used link shows error view

---

## Supersedes

Authentication section in `docs/history/implemented/specs/2026-06-12-hermes-assistant-companion-design.md`:

- Removes assumption of pre-provisioned operator credentials
- Adds magic-link onboarding and reset views alongside existing `LoginView`