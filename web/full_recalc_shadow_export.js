(function(){
  "use strict";
  function sha256(text){
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error("SHADOW_EXPORT_HASH_UNAVAILABLE"));
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function(buffer){ return Array.from(new Uint8Array(buffer)).map(function(v){ return v.toString(16).padStart(2,"0"); }).join(""); });
  }
  function guard(){
    var env = String(window.JKH_ENV_TYPE || window.ENV_TYPE || "").trim().toUpperCase();
    if (!env || env === "PROD") throw new Error("SHADOW_EXPORT_FORBIDDEN_IN_PROD");
  }
  window.JKHShadowExport = {
    exportPermanentResult: async function(payload){
      guard();
      if (!window.JKHFullRecalcShadowCompare) throw new Error("SHADOW_COMPARE_UNAVAILABLE");
      var source = payload && typeof payload === "object" ? payload : {};
      if (!source.uid || !Array.isArray(source.ledger) || !Array.isArray(source.calculatedRows) || !source.financialInputs || !source.referenceResult) throw new Error("SHADOW_EXPORT_INPUT_INVALID");
      if (String(source.mode || "permanent_full_recalc") !== "permanent_full_recalc" || source.temporary === true) throw new Error("SHADOW_MODE_INVALID");
      var fixture = {
        schemaVersion:1, mode:"permanent_full_recalc", executionMode:"shadow", ownerId:source.ownerId || "", namespace:source.namespace || "", abonentId:String(source.abonentId || ""), uid:String(source.uid), calculationDate:String(source.calculationDate || ""), responsibilityPeriod:source.responsibilityPeriod || null,
        ledger:source.ledger, financialInputs:source.financialInputs, calculatedRows:source.calculatedRows, versions:source.versions || null, engineVersion:source.engineVersion || "", ledgerVersion:source.ledgerVersion || "", calculationOptions:source.calculationOptions || {}, referenceResult:source.referenceResult
      };
      var hashSource = Object.assign({}, fixture); delete hashSource.referenceResult;
      fixture.inputHash = await sha256(window.JKHFullRecalcShadowCompare.stableStringify(hashSource));
      return fixture;
    },
    downloadPermanentResult: async function(payload){
      var fixture = await this.exportPermanentResult(payload);
      var blob = new Blob([JSON.stringify(fixture, null, 2)], { type:"application/json" });
      var href = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = href;
      link.download = "full-recalc-shadow-" + fixture.uid + ".json";
      link.click();
      URL.revokeObjectURL(href);
      return fixture;
    }
  };
})();
