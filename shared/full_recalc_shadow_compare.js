(function(root, factory){
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.JKHFullRecalcShadowCompare = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function(){
  "use strict";
  var IGNORED = { timings:true, generatedAt:true, runId:true, environment:true, memoryUsage:true };
  function canonical(value){
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
    var out = {};
    Object.keys(value).sort().forEach(function(key){ if (!IGNORED[key]) out[key] = canonical(value[key]); });
    return out;
  }
  function stableStringify(value){ return JSON.stringify(canonical(value)); }
  function compare(oldValue, candidateValue, path, category, diffs){
    if (typeof oldValue !== typeof candidateValue) return diffs.push({ path:path, category:category, oldValue:oldValue, candidateValue:candidateValue, differenceType:"type_mismatch", severity:"critical", message:"Type differs" });
    if (Array.isArray(oldValue) || Array.isArray(candidateValue)) {
      if (!Array.isArray(oldValue) || !Array.isArray(candidateValue) || oldValue.length !== candidateValue.length) return diffs.push({ path:path, category:category, oldValue:oldValue, candidateValue:candidateValue, differenceType:"length_mismatch", severity:"critical", message:"Array length differs" });
      for (var i=0;i<oldValue.length;i++) compare(oldValue[i], candidateValue[i], path+"["+i+"]", category, diffs);
      return;
    }
    if (oldValue && typeof oldValue === "object") {
      var keys = Array.from(new Set(Object.keys(oldValue).concat(Object.keys(candidateValue || {})))).sort();
      keys.forEach(function(key){
        if (!(key in oldValue) || !(key in candidateValue)) diffs.push({ path:path+"."+key, category:category, oldValue:oldValue[key], candidateValue:candidateValue[key], differenceType:(key in oldValue ? "missing" : "extra"), severity:"critical", message:"Key differs" });
        else compare(oldValue[key], candidateValue[key], path+"."+key, category, diffs);
      });
      return;
    }
    if (oldValue !== candidateValue) diffs.push({ path:path, category:category, oldValue:oldValue, candidateValue:candidateValue, differenceType:(typeof oldValue === "number" ? "numeric_mismatch" : "value_mismatch"), severity:"critical", message:"Value differs" });
  }
  function strictDiff(reference, candidate){ var diffs=[]; compare(canonical(reference), canonical(candidate), "$", "financial_result", diffs); return diffs; }
  return { IGNORED_FIELDS:Object.keys(IGNORED), canonical:canonical, stableStringify:stableStringify, strictDiff:strictDiff };
});
