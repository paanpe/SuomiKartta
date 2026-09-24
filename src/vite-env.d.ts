/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the MML proxy (the Azure Function), e.g. https://x.azurewebsites.net/api */
  readonly VITE_MML_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
