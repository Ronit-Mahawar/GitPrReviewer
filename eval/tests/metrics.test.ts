import test from "node:test";
import assert from "node:assert/strict";
import { calculateMetrics, falsePositiveRateOnCleanCases } from "../metrics";
test("hand-computed precision, recall, and F1",()=>{
  const m=calculateMetrics({tp:3,fp:1,fn:2});assert.equal(m.precision,0.75);assert.equal(m.recall,0.6);assert.equal(m.f1,2*0.75*0.6/1.35);
});
test("clean false-positive rate is comments per clean PR",()=>assert.equal(falsePositiveRateOnCleanCases(3,2),1.5));
