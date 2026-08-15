import test from "node:test";
import assert from "node:assert/strict";
import { wilson, thetaLicensed, label, nMin } from "../app/readiness.mjs";

const round = (x, d = 4) => Number(x.toFixed(d));

test("unmeasured processes license nothing", () => {
  assert.equal(thetaLicensed(0, 0), 0);
  assert.equal(label({ x: 0, n: 0, floor: 0.9 }), "UNMEASURED");
});

test("published bounds are locked", () => {
  assert.equal(round(thetaLicensed(8, 8)), 0.6756);
  assert.equal(round(thetaLicensed(12, 12)), 0.7575);
  assert.equal(round(thetaLicensed(20, 20)), 0.8389);
  assert.equal(round(thetaLicensed(40, 40)), 0.9124);
});

test("closed form n/(n+z^2) agrees at perfect agreement", () => {
  const z2 = 1.959963984540054 ** 2;
  for (const n of [8, 20, 40, 80]) {
    assert.ok(Math.abs(thetaLicensed(n, n) - n / (n + z2)) < 1e-9);
  }
});

test("twenty perfect attestations do not clear a 0.90 floor", () => {
  assert.equal(label({ x: 20, n: 20, floor: 0.9 }), "NOT YET DISTINGUISHED");
});

test("rule-out is cheap, rule-in is expensive", () => {
  assert.equal(label({ x: 2, n: 8, floor: 0.9 }), "RULED OUT");
  assert.equal(nMin(0.9), 35);
  assert.equal(nMin(0.95), 73);
});

test("interval brackets the point estimate", () => {
  const [lo, hi] = wilson(17, 20);
  assert.ok(lo < 0.85 && hi > 0.85);
});
