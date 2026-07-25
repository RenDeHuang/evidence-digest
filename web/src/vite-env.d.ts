/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override for the static API base URL. Defaults to `${BASE_URL}api` when unset. */
  readonly VITE_API_BASE?: string;
  /**
   * Base URL of the Cloudflare Worker that powers email subscribe/manage.
   * When empty, /subscribe and /manage render an honest "not switched on" state
   * instead of a broken form.
   */
  readonly VITE_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
