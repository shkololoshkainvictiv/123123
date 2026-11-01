# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Default-Deny Catch-All**: Every path not explicitly matched under `/databases/{database}/documents` is unconditionally denied (`allow read, write: if false;`).
2. **Verified Identity**: All write operations require an authenticated user (`request.auth != null`) with a verified email (`request.auth.token.email_verified == true`).
3. **Administrator Authority**: Only a verified administrator (`shkololoshka.invictiv@gmail.com` with `email_verified == true`, or a user whose UID exists in `/admins/$(request.auth.uid)`) can create, update roles/sections of arbitrary accounts, list all accounts, or delete accounts in `/users/{userId}`.
4. **No Self-Privilege Escalation**: A non-admin user can never create or update a document with `role == 'admin'` or modify their own `role`, `allowedSections`, or `active` status.
5. **PII & Query Isolation**: `/users/{userId}` documents contain login/email identifiers and may only be read (`get`/`list`) by their owner (`resource.data.uid == request.auth.uid` or `userId == request.auth.uid`) or by an administrator (`isAdmin()`). Blanket `isSignedIn()` reads are forbidden.
6. **Strict Schema, Key Allowlisting & Volumetric Bounds**:
   - Document IDs must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters.
   - `UserAccount` documents must contain only `['uid', 'login', 'displayName', 'role', 'allowedSections', 'active', 'createdAt', 'updatedAt']`.
   - `allowedSections` must be a list with `size() <= 25`, and when non-empty its first element must be a string `<= 50` chars.
   - `createdAt` must equal `request.time` on `create` and remain immutable on `update`; `updatedAt` must equal `request.time` on both `create` and `update`.

## 2. The "Dirty Dozen" Payloads

1. **Unauthenticated Write**: `auth = null`, creating `/users/user_1` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: `auth = { uid: 'spoof', token: { email: 'shkololoshka.invictiv@gmail.com', email_verified: false } }`, creating `/users/user_1` -> `PERMISSION_DENIED`.
3. **Self-Assigned Admin Role**: Non-admin user creating `/users/user_self` with `role: 'admin'` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on Create**: Admin creating `/users/user_1` with extra field `isSuperUser: true` -> `PERMISSION_DENIED`.
5. **Shadow Field Injection on Update**: Owner updating `/users/user_1` with extra field `hacked: true` -> `PERMISSION_DENIED`.
6. **Privilege Escalation on Update**: Non-admin owner updating `/users/user_1` to change `role: 'admin'` or `allowedSections: ['all']` -> `PERMISSION_DENIED`.
7. **ID Poisoning Attack**: Path variable `{userId}` containing invalid characters (`user$bad!id` or >128 chars) -> `PERMISSION_DENIED`.
8. **Value Poisoning (Oversized String)**: Setting `displayName` to a 500-character string (`> 120` max) -> `PERMISSION_DENIED`.
9. **Array Overflow Attack**: Setting `allowedSections` to an array of 30 items (`> 25` max) -> `PERMISSION_DENIED`.
10. **Array Element Type Poisoning**: Setting `allowedSections` to `[12345]` (non-string first element) -> `PERMISSION_DENIED`.
11. **Timestamp Forgery / Mutation**: Creating with client timestamp `createdAt != request.time` or updating `createdAt` to a new value -> `PERMISSION_DENIED`.
12. **PII Horizontal Scraping**: Authenticated non-admin user `user_b` attempting `get` or unrestricted `list` on `/users/user_a` -> `PERMISSION_DENIED`.
