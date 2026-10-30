import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default 5s is too tight for the full suite on CI runners.
    testTimeout: 10_000,
    server: {
      deps: {
        // Lobe Avatar imports UI modules that load Emoji Mart JSON through Vite.
        inline: [/@lobehub\/ui/, /@emoji-mart\/data/],
      },
    },
    deps: {
      optimizer: {
        // Phosphor's entry re-exports thousands of icon modules. Pre-bundle it
        // once instead of loading each file over the 9p mount on every run.
        client: { enabled: true, include: ["@phosphor-icons/react"] },
        ssr: { enabled: true, include: ["@phosphor-icons/react"] },
      },
    },
  },
});
