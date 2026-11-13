import test from "node:test";
import assert from "node:assert/strict";
import { matchComments } from "../match";
test("matches compatible bug comments within configurable line tolerance and leaves FN",()=>{
  const result=matchComments([{file:"a.ts",line:13,category:"bug",message:"Possible null dereference"},{file:"a.ts",line:30,category:"bug",message:"other"}], [{file:"a.ts",line_start:10,line_end:10,bug_type:"null_deref",severity:"high",description:"null"},{file:"b.ts",line_start:4,line_end:4,bug_type:"xss",severity:"high",description:"xss"}],3);
  assert.deepEqual(result.labels.map(x=>x.auto_label),["TP","unmatched"]);assert.deepEqual(result.missed_truth,[1]);
});
test("clean-case predictions are false positives",()=>assert.equal(matchComments([{file:"a",line:1,message:"unused"}],[],3).labels[0].auto_label,"FP"));
