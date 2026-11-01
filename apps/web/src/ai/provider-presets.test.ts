import { expect, it } from "vitest";
import { inferProvider, sameConnection } from "./provider-presets";

it("does not classify a manually customized path as a preset", () => {
  expect(
    inferProvider({
      protocol: "openai",
      url: "https://api.deepseek.com/custom/../v1",
    }),
  ).toBe("custom");
});

it("treats different custom paths as different server connection identities", () => {
  expect(
    sameConnection(
      { protocol: "openai", url: "https://relay.example/custom/../v1" },
      { protocol: "openai", url: "https://relay.example/v1" },
    ),
  ).toBe(false);
});

it("retains the server identity for normalized casing, ports and trailing slashes", () => {
  expect(
    sameConnection(
      { protocol: "openai", url: "https://RELAY.example:443/v1/" },
      { protocol: "openai", url: " https://relay.example/v1 " },
    ),
  ).toBe(true);
});
