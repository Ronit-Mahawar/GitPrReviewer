export interface Counts { tp: number; fp: number; fn: number; }
export function calculateMetrics({tp,fp,fn}:Counts) {
  const precision=tp+fp===0?null:tp/(tp+fp); const recall=tp+fn===0?null:tp/(tp+fn);
  const f1=precision===null||recall===null?(precision===0||recall===0?0:null):(precision+recall===0?0:2*precision*recall/(precision+recall));
  return {precision,recall,f1};
}
export function falsePositiveRateOnCleanCases(falsePositives:number, cleanRuns:number) { return cleanRuns===0?null:falsePositives/cleanRuns; }
