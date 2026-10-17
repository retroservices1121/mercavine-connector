# Database backups

Mercavine's data lives in one SQLite file on a Railway volume (`MERCAVINE_DB_PATH`).
`src/lib/backup.ts` takes a nightly consistent snapshot with `VACUUM INTO`,
gzips it, encrypts it with AES-256-GCM, and uploads it to S3-compatible storage.

The job is **off** until all of these Railway variables are set:

| Variable | Value |
|---|---|
| `BACKUP_S3_ENDPOINT` | e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | bucket name (private, versioning or object lock on) |
| `BACKUP_S3_REGION` | `auto` for R2; the bucket region elsewhere |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | key limited to writing that bucket |
| `BACKUP_ENCRYPTION_KEY` | `openssl rand -base64 32`; also store it in a password manager |
| `BACKUP_S3_PREFIX` (optional) | default `mercavine/` |
| `BACKUP_HOUR_UTC` (optional) | default `7` (3 AM Eastern in summer) |

Set a lifecycle rule on the bucket to expire objects after 30 days so backups
honour the 30-day deletion promise (a deleted account disappears from backups
within 30 days).

## Restore

1. Download the backup object (e.g. `mercavine/2026-10-17T07-00-00-000Z.sqlite.gz.enc`) from the bucket console.
2. Decrypt locally:
   ```sh
   export BACKUP_ENCRYPTION_KEY='<from password manager>'   # type it, don't paste into chat
   node scripts/restore-backup.mjs backup.sqlite.gz.enc restored.sqlite
   sqlite3 restored.sqlite "PRAGMA integrity_check;"
   ```
3. To put it back in production: scale the Railway service to zero (or stop it),
   copy `restored.sqlite` onto the volume at `MERCAVINE_DB_PATH` (remove the old
   `-wal`/`-shm` files), then start the service.
4. Do a test restore at least once a quarter and note the date in SECURITY.md.
