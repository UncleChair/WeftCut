---
status: accepted
---

# Derivative jobs run against a pending hash before the content hash is final

Cache artifacts (proxies, thumbnails, waveforms) are content-addressed by the source file's BLAKE3 hash. Hashing a multi-gigabyte import takes seconds-to-minutes, and so does the workspace copy. Rather than serialize *copy → hash → enqueue derivatives*, the import enqueues derivative jobs immediately against a temporary `pending-{media_id}` cache key, while the copy-and-hash runs in parallel. When the copy finishes, `cache::migrate_hash_artifacts` renames any `pending-{media_id}.*` cache files to their real content-hash names, and `patch_derivative_paths_after_hash_migration` rewrites the `proxy_path` / `quick_proxy_path` strings any job already committed.

A second guard backs this up: every job re-reads the latest `MediaItem` (`fresh_media_item`) immediately before spawning ffmpeg, so a job that was queued under the pending hash but starts *after* the migration picks up the final hash and writes to the correct cache key from the start.

Rationale:

- The dominant cost of importing a large clip is copy + hash, and the dominant cost of making it editable is the proxy. Overlapping them — instead of running them back to back — is the single biggest win in time-to-editable, and is what "import optimization" on this path actually means.
- Content addressing must still hold at rest: two imports of the same bytes share one cache entry, and a cache hit on re-import skips regeneration. The pending key is a transient alias that always resolves to the content hash before the import is marked complete.

Trade-offs:

- **Two code paths write the final cache key** — the migration (for jobs that committed early) and `fresh_media_item` (for jobs that start late). They are convergent, not exclusive: whichever applies, the artifact ends up at the content-hash path. The migration is a no-op when `old_hash == new_hash` (re-import cache hit, where the hash is known up front).
- **A job that fails mid-flight may leave a `pending-{media_id}` file behind.** These are cheap, self-correcting (a later run promotes or overwrites), and swept by the cache's normal hygiene; the migration's rename is best-effort and logged on failure rather than fatal.
- **Path rewriting is string replacement** on the cache path, which is safe because the hash is a long random token that does not collide with surrounding path components.
