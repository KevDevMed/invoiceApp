-- 002_model_diagnostics: give the models table real columns for the two facts
-- that were previously overloaded onto `models.error`.
--
-- Additive only. No column is dropped and no row is deleted; the single UPDATE
-- moves a smoke-test payload out of `error` (where 001 had no better home for
-- it) and into its own column, restoring `error` to meaning only "the download
-- failed, and this is why".
--
-- `verified_sha256` is the digest the downloader actually computed over the
-- bytes on disk, written only after the hash matched the expected one. A NULL
-- here means "these bytes were never verified", which is what stops boot
-- reconciliation from promoting a file to `ready` on its size alone.
--
-- The runner wraps this file in a transaction and records it in `_migrations`,
-- so it runs exactly once per database.

ALTER TABLE models ADD COLUMN smoke_test TEXT;
ALTER TABLE models ADD COLUMN verified_sha256 TEXT;

-- Existing rows whose `error` is really a smoke-test record move across.
UPDATE models
   SET smoke_test = error,
       error = NULL
 WHERE error LIKE '{%"kind":"smokeTest"%';

-- `verified_sha256` is deliberately left NULL for every existing row, including
-- `ready` ones: the old code could promote a file on size alone, so a populated
-- `sha256` is not proof that these particular bytes were ever hashed. Those rows
-- drop to `available` on the next boot and the downloader re-verifies the file
-- in place (no re-download when the hash matches).
