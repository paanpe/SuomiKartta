/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the MML proxy, e.g. /api on Azure Static Web Apps or http://localhost:7071/api */
  readonly VITE_MML_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
