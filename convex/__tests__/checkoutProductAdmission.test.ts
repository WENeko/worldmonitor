import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { LEGACY_PRODUCT_ALIASES, PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import schema from "../schema";

// Mock only the provider transport; checkout, guards and persistence are real.
vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const buyer = { subject: "user_product_admission", tokenIdentifier: "clerk|user_product_admission" };
const products: Array<[string, string | null]> = [
  ...Object.values(PRODUCT_CATALOG)
    .filter((plan) => plan.dodoProductId)
    .map((plan): [string, string] => [plan.dodoProductId!, plan.planKey]),
  ...Object.entries(LEGACY_PRODUCT_ALIASES),
  ["pdt_unmapped_investigation", null],
  ["not-a-product-id", null],
];

beforeEach(() => {
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-product-admission-secret");
});

afterEach(() => {
  vi.mocked(createDodoCheckoutSession).mockReset();
  vi.unstubAllEnvs();
});

test.each(products)("checkout forwards %s with plan metadata %s but grants no entitlement", async (productId, planKey) => {
  const t = convexTest(schema, modules);
  vi.mocked(createDodoCheckoutSession).mockResolvedValue({ checkout_url: "https://checkout.example/session" });
  const result = await t.withIdentity(buyer).action(api.payments.checkout.createCheckout, { productId });
  expect(result).toEqual({ checkout_url: "https://checkout.example/session" });
  expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(createDodoCheckoutSession).mock.calls[0][0];
  expect(payload.product_cart).toEqual([{ product_id: productId, quantity: 1 }]);
  if (planKey) expect(payload.metadata?.wm_plan_key).toBe(planKey);
  else expect(payload.metadata).not.toHaveProperty("wm_plan_key");
  expect(await t.run((ctx) => ctx.db.query("entitlements").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("subscriptions").collect())).toEqual([]);
});

test.each(["pdt_unmapped_investigation", "not-a-product-id"])(
  "provider rejection of %s creates no subscription or entitlement",
  async (productId) => {
    const t = convexTest(schema, modules);
    vi.mocked(createDodoCheckoutSession).mockRejectedValue(new Error("synthetic provider product rejection"));
    await expect(t.withIdentity(buyer).action(api.payments.checkout.createCheckout, { productId }))
      .rejects.toThrow("synthetic provider product rejection");
    expect(createDodoCheckoutSession).toHaveBeenCalledTimes(1);
    expect(await t.run((ctx) => ctx.db.query("entitlements").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("subscriptions").collect())).toEqual([]);
  },
);
