# SEVNT License System — Database Schema

Google Spreadsheet ID is stored in Script Properties as `SPREADSHEET_ID`.

---

## Sheet: LICENSES

| Column | Type | Description |
|--------|------|-------------|
| `license_id` | UUID | Primary key |
| `license_key_hash` | SHA256 hex | Hash of normalized license key (NEVER plaintext) |
| `license_key_prefix` | 8 chars | First 8 chars of key (for support lookup only) |
| `customer_email` | string | Buyer email |
| `order_id` | string | Payment order reference |
| `status` | enum | `ACTIVE` \| `REVOKED` |
| `payment_status` | enum | `PENDING` \| `PAID` \| `FAILED` |
| `created_at` | ISO8601 | Record creation time |
| `updated_at` | ISO8601 | Last update time |
| `notes` | string | Admin notes (never license key) |

**Key rule:** Only `ACTIVE` + `PAID` licenses can be activated.

---

## Sheet: DEVICES

| Column | Type | Description |
|--------|------|-------------|
| `device_id` | UUID | Primary key |
| `license_id` | UUID | FK → LICENSES |
| `device_role` | enum | `PRIMARY_LAPTOP` \| `MOBILE_COMPANION` |
| `machine_hash` | SHA256 hex | Hash of `machine:<raw_machine_id>` |
| `device_token_hash` | SHA256 hex | Hash of `device_token:<raw_token>` |
| `device_name` | string | Human-readable name |
| `status` | enum | `ACTIVE` \| `REVOKED` |
| `activated_at` | ISO8601 | First activation time |
| `last_seen` | ISO8601 | Last successful validation time |
| `paired_laptop_device_id` | UUID | For MOBILE: device_id of associated laptop |
| `revoked_at` | ISO8601 | When device was revoked (empty if active) |
| `revocation_reason` | string | Support reason + ticket + operator |

**Slot rule:** At most 1 ACTIVE `PRIMARY_LAPTOP` and 1 ACTIVE `MOBILE_COMPANION` per `license_id`.

---

## Sheet: PAYMENTS

| Column | Type | Description |
|--------|------|-------------|
| `order_id` | string | Unique order ID from payment provider |
| `provider` | string | `lynk.id` |
| `provider_transaction_id` | string | Provider's internal TX ID |
| `customer_email` | string | Buyer email |
| `amount` | number | Payment amount |
| `currency` | string | e.g. `IDR` |
| `payment_status` | enum | `PENDING` \| `PAID` \| `FAILED` |
| `received_at` | ISO8601 | When webhook was received |
| `processed_at` | ISO8601 | When license was created |
| `license_id` | UUID | FK → LICENSES (set after license creation) |
| `event_digest` | SHA256 hex | Idempotency key: sha256(order_id + status + tx_id) |

---

## Sheet: EMAIL_OUTBOX

| Column | Type | Description |
|--------|------|-------------|
| `email_id` | UUID | Primary key |
| `license_id` | UUID | FK → LICENSES |
| `recipient` | email | Destination email address |
| `template` | enum | `LICENSE_DELIVERY` \| `SUPPORT_RECOVERY` \| `ACTIVATION_CONFIRM` |
| `status` | enum | `PENDING` \| `SENT` \| `FAILED` |
| `attempts` | int | Delivery attempt count (max 3) |
| `created_at` | ISO8601 | Queue time |
| `sent_at` | ISO8601 | Successful send time |
| `last_error` | string | Last error message if failed |
| `payload` | JSON string | Template-specific data (may contain license key for delivery) |

---

## Sheet: AUDIT_LOG

| Column | Type | Description |
|--------|------|-------------|
| `event_id` | UUID | Primary key |
| `event_type` | enum | See below |
| `license_id` | UUID | Related license (may be empty) |
| `device_id` | UUID | Related device (may be empty) |
| `actor` | string | `system` \| `support:<email>` \| `user` |
| `result` | enum | `SUCCESS` \| `FAILURE` |
| `created_at` | ISO8601 | Event time |
| `details` | JSON string | Sanitized context (no secrets/tokens) |

**Event types:** `ACTIVATE_LAPTOP`, `ACTIVATE_MOBILE`, `VALIDATE`, `DEACTIVATE`, `SUPPORT_RESET`, `SUPPORT_RECOVER`, `LICENSE_CREATED`, `LICENSE_REVOKED`, `PAYMENT_RECEIVED`, `EMAIL_QUEUED`, `EMAIL_SENT`, `EMAIL_FAILED`, `UNAUTHORIZED_ADMIN`, `ERROR`

---

## Security Notes

- `license_key_hash`: SHA256 of `license:` + normalized(key). **Never store plaintext key.**
- `machine_hash`: SHA256 of `machine:` + raw machine_id from client.
- `device_token_hash`: SHA256 of `device_token:` + raw token. **Raw token sent once, never stored.**
- `audit_log.details`: Sanitized — `admin_secret`, `device_token`, `license_key` fields replaced with `[REDACTED]`.
