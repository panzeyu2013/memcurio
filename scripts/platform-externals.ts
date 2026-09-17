// The frozen platform seed table (PLATFORM_MODULES in the dsh client shell,
// read from the installed dsh-web-frontend bundle): the ONLY specifiers a
// third-party browser bundle may require at runtime, and therefore the esbuild
// externals list. Shared by scripts/build-client.ts (build) and
// scripts/pack-check.ts (gate) so the two can never drift apart.
export const PLATFORM_EXTERNALS: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
];
