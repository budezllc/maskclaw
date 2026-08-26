/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SURFACE: "local" | "appliance";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
