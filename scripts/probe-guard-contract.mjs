/**
 * Per-host config-resolution contract, executed inside a probe profile by
 * scripts/probe-compat.ts.
 *
 * The matrix boots the product, but a regression in the settings pre-write gate
 * is invisible to HTTP assertions: on 0.2.2-alpha.3 the pre-fix listener
 * accepted a lone route half while every route still answered 200. This script
 * drives the guard the way `dsh-config-editor` does — the installed tarball's
 * own module against this host's own cordis — and prints one JSON line with
 * every outcome, so a failure names the case that broke.
 */
import { Context } from "@deepseek-ai/cordis";

import { guardConfigResolution } from "./node_modules/@memcurio/dsh-plugin/dist/plugin/settings.js";

const root = new Context();
const fiber = await root.plugin(
  { name: "guard-contract", apply(inner) { guardConfigResolution(inner); } },
  {},
);

// `fiber.resolveConfig` is the editor's pre-write gate on the 0.2.2 line; older
// hosts only expose the update waterfall, which is not awaitable there.
const resolveTo = (candidate) => {
  try {
    if (typeof fiber.resolveConfig === "function") fiber.resolveConfig(candidate);
    else fiber.update(candidate, true);
    return "accepted";
  } catch (error) {
    return String(error?.message ?? error);
  }
};

// A lone half is refused in every published dispatch shape; an unevaluated
// `!!js` expression counts as a present half; empty halves are refused; a
// complete pair resolves; another plugin's own `provider` field is untouched.
const outcomes = {
  providerOnly: resolveTo({ root: "/tmp", provider: "only" }),
  modelOnly: resolveTo({ root: "/tmp", model: "only" }),
  expressionHalf: resolveTo({ root: "/tmp", provider: { __jsExpr: "'p'" }, model: null }),
  emptyPair: resolveTo({ root: "/tmp", provider: "", model: "" }),
  pair: resolveTo({ root: "/tmp", provider: "p", model: "m" }),
};

let otherOwner = true;
try {
  await root.plugin({ name: "other-owner", apply() {} }, { provider: "x" });
} catch {
  otherOwner = false;
}

const ok = /together/.test(outcomes.providerOnly)
  && /together/.test(outcomes.modelOnly)
  && /together/.test(outcomes.expressionHalf)
  && /non-empty/.test(outcomes.emptyPair)
  && outcomes.pair === "accepted"
  && otherOwner;
await root.fiber.dispose();
console.log(JSON.stringify({ ok, outcomes, otherOwner }));
