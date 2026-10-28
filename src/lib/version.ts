/**
 * Single source of truth for the deployed app version.
 * Keep in sync with package.json — bumped together every release.
 * Every consumer (db-init boot webhook, /api/version) imports from here
 * so no endpoint can ever serve a stale hardcoded number again.
 */
export const APP_VERSION = '3.11.3'
