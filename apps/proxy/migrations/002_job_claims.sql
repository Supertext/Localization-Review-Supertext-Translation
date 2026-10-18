-- A status poll claims a job Supertext has finished (status 'fetching') before downloading it,
-- so concurrent polls download and store it once. Stale claims expire.
ALTER TABLE jobs ADD COLUMN claimed_at timestamptz;
