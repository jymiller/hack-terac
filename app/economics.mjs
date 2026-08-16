/**
 * What a read costs, by whom.
 *
 * The business question is not who reads best. An agent reads every document anyway, so the
 * only open questions are: which is the CHEAPEST agent that reads well enough, and what does
 * the human attestation on top of it cost. Those are different questions with different
 * answers, and a single accuracy ranking answers neither.
 *
 * Prices are Novita's published list rates, per million tokens, read from novita.ai/pricing
 * on 2026-08-15. They are not measured by us — if Novita moves a price this table is stale,
 * so cost figures derived here name their source on screen rather than presenting as fact.
 */

export const PRICES_AS_OF = "2026-08-15";
export const PRICE_SOURCE = "novita.ai/pricing, published list rates";

/** USD per 1M tokens. Keyed by the model id tail, so the provider prefix does not matter. */
const PRICES = {
  "llama-4-scout-17b-16e-instruct": { in: 0.18, out: 0.59 },
  "llama-4-maverick-17b-128e-instruct-fp8": { in: 0.27, out: 0.85 },
  "qwen3-vl-235b-a22b-instruct": { in: 0.3, out: 1.5 },
  "qwen3-vl-30b-a3b-instruct": { in: 0.2, out: 0.7 },
  "gemma-3-27b-it": { in: 0.119, out: 0.2 },
};

export const priceFor = (modelId) => {
  if (!modelId) return null;
  const tail = String(modelId).split("/").pop();
  return PRICES[tail] ?? null;
};

/**
 * Cost of one read in cents. Returns null rather than 0 when either the price or the token
 * count is unknown — a missing cost must never render as "free", which is precisely the error
 * that let a model look infinitely cheaper than a person.
 */
export function readCostCents(modelId, usage) {
  const p = priceFor(modelId);
  if (!p || !usage) return null;
  const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!inTok && !outTok) return null;
  return ((inTok / 1e6) * p.in + (outTok / 1e6) * p.out) * 100;
}

/** Pretty cents, down to a hundredth of a cent, because a model read costs less than a cent. */
export function money(cents) {
  if (cents == null) return null;
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  if (cents >= 1) return `${cents.toFixed(1)}¢`;
  return `${cents.toFixed(3)}¢`;
}

/**
 * The frontier: of the readers that clear `floor` on their 95% lower bound, the cheapest.
 * Ranking on the bound rather than the observed rate is the whole discipline — a reader that
 * happens to have scored 100% on three documents has not earned the right to be called cheap
 * enough, it has earned the right to be measured further.
 */
export function cheapestClearing(readers, floor) {
  const eligible = readers.filter((r) => r.lo >= floor && r.cost_cents != null);
  if (!eligible.length) return null;
  return eligible.sort((a, b) => a.cost_cents - b.cost_cents)[0];
}
