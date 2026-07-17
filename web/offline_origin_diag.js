(function () {
  "use strict";

  var state = window.__JKH_OFFLINE_ORIGIN = {
    startedAt: Date.now(),
    eventOrder: 0,
    sequence: 0,
    transitions: [],
    endpoints: [],
    restoredRows: 0,
    snapshotFresh: false,
    snapshotBackendSucceeded: false,
    localStorageErrorActive: false,
    networkErrorActive: false
  };

  function currentUiState() {
    var ui = window.JKH_UI_STATE && typeof window.JKH_UI_STATE === "object" ? window.JKH_UI_STATE : {};
    return {
      dataStatus: String(ui.data && ui.data.status || ""),
      dataSource: String(ui.data && ui.data.source || ""),
      serverStatus: String(ui.server && ui.server.status || "")
    };
  }

  function runtimeHydrated() {
    var db = window.AbonentsDB && typeof window.AbonentsDB === "object" ? window.AbonentsDB : {};
    return !!(db.abonents && typeof db.abonents === "object" && Object.keys(db.abonents).length);
  }

  function stackDetails(stack) {
    var frames = String(stack || "").split("\n").slice(1, 7).map(function (line) { return String(line || "").trim(); }).filter(Boolean);
    var callerFrame = frames.filter(function (line) {
      return line.indexOf("_setUIState") < 0 && line.indexOf("__offlineOriginRecordTransition") < 0;
    })[0] || "";
    var location = callerFrame.match(/(?:\(|@)([^()]+:\d+:\d+)\)?$/) || callerFrame.match(/([^ ]+:\d+:\d+)$/);
    return {
      caller: callerFrame.replace(/^at\s+/, "").split(/\s+\(|@/)[0] || "",
      callSite: location ? String(location[1] || "") : "",
      stack: frames
    };
  }

  window.__offlineOriginRecordTransition = function (input) {
    var value = input && typeof input === "object" ? input : {};
    var previousDataStatus = String(value.previousDataStatus || "");
    var newDataStatus = String(value.newDataStatus || "");
    var previousDataSource = String(value.previousDataSource || "");
    var newDataSource = String(value.newDataSource || "");
    var previousServerStatus = String(value.previousServerStatus || "");
    var newServerStatus = String(value.newServerStatus || "");
    if (previousDataStatus === newDataStatus && previousDataSource === newDataSource && previousServerStatus === newServerStatus) return;
    var details = stackDetails(value.stack);
    var entry = {
      sequence: ++state.sequence,
      lifecycleOrder: ++state.eventOrder,
      timestamp: new Date().toISOString(),
      module: String(value.module || ""),
      setter: String(value.setter || "_setUIState"),
      caller: details.caller,
      callSite: details.callSite,
      reason: String(value.reason || ""),
      stack: details.stack,
      previousDataStatus: previousDataStatus,
      newDataStatus: newDataStatus,
      previousDataSource: previousDataSource,
      newDataSource: newDataSource,
      previousServerStatus: previousServerStatus,
      newServerStatus: newServerStatus,
      hydratedRuntimeAtWrite: runtimeHydrated(),
      restoredRowsAtWrite: Number(state.restoredRows || 0),
      snapshotFreshAtWrite: state.snapshotFresh === true,
      localStorageErrorActive: state.localStorageErrorActive === true,
      networkErrorActive: state.networkErrorActive === true
    };
    state.transitions.push(entry);
    try { console.log("[offline-origin][transition]", entry); } catch (e) {}
  };

  window.__offlineOriginMarkLocalStorageError = function (error, source) {
    state.localStorageErrorActive = true;
    state.lastLocalStorageError = {
      timestamp: new Date().toISOString(),
      source: String(source || ""),
      name: String(error && error.name || ""),
      message: String(error && error.message || error || "")
    };
  };

  window.__offlineOriginMarkPassiveRestore = function (input) {
    var value = input && typeof input === "object" ? input : {};
    state.snapshotFresh = value.snapshotFresh === true || state.snapshotFresh === true;
    state.snapshotBackendSucceeded = value.backendSucceeded === true || state.snapshotBackendSucceeded === true;
    state.restoredRows = Math.max(Number(state.restoredRows || 0), Number(value.restoredRows || 0));
    state.passiveRestore = Object.assign({}, state.passiveRestore || {}, value, { timestamp: new Date().toISOString(), lifecycleOrder: ++state.eventOrder });
  };

  window.__offlineOriginRecordEndpoint = function (input) {
    var value = input && typeof input === "object" ? input : {};
    var endpoint = String(value.endpoint || "");
    var networkFailure = value.networkFailure === true;
    var entry = {
      sequence: state.endpoints.length + 1,
      lifecycleOrder: ++state.eventOrder,
      timestamp: new Date().toISOString(),
      endpoint: endpoint,
      method: String(value.method || "GET"),
      ok: value.ok === true,
      status: value.status === undefined ? null : value.status,
      networkFailure: networkFailure,
      error: String(value.error || "")
    };
    state.endpoints.push(entry);
    if (networkFailure) state.networkErrorActive = true;
    if (entry.ok && (endpoint.indexOf("/api/store_dump") >= 0 || endpoint.indexOf("/api/auth/me") >= 0 || endpoint.indexOf("/auth/status") >= 0)) {
      state.networkErrorActive = false;
    }
    if (entry.ok && endpoint.indexOf("/api/card_snapshot/") >= 0) state.snapshotBackendSucceeded = true;
    try { console.log("[offline-origin][endpoint]", entry); } catch (e) {}
  };

  function classify(firstOffline, lastOffline, laterReadable, finalState) {
    var offlineWriters = state.transitions.filter(function (entry) { return entry.newDataStatus === "offline" || entry.newServerStatus === "offline"; });
    var modules = {};
    offlineWriters.forEach(function (entry) { modules[entry.module + "|" + entry.callSite] = true; });
    var hadReadableBeforeLastOffline = state.transitions.some(function (entry) {
      return lastOffline && entry.sequence < lastOffline.sequence && (entry.newDataStatus === "ready" || entry.newDataStatus === "empty");
    });
    if (Object.keys(modules).length > 1) return "MULTIPLE_WRITERS";
    if (lastOffline && lastOffline.localStorageErrorActive && !lastOffline.networkErrorActive) return "LOCAL_CACHE_ERROR_MISCLASSIFIED";
    if (hadReadableBeforeLastOffline && lastOffline && lastOffline.module === "auth") return "AUTH_REDOWNGRADE";
    if (hadReadableBeforeLastOffline && lastOffline && lastOffline.module === "storage") return "STORAGE_REDOWNGRADE";
    if (state.snapshotBackendSucceeded && state.snapshotFresh && state.restoredRows > 0 && !laterReadable && finalState.dataStatus === "offline") return "PASSIVE_RESTORE_NO_READY_PROMOTION";
    if (firstOffline && firstOffline.module === "storage" && firstOffline.caller.indexOf("_loadFromServerServerFirst") >= 0) return "STORAGE_DUMP_NETWORK_FAILURE";
    if (firstOffline && firstOffline.module === "auth" && (firstOffline.caller.indexOf("syncSessionFromServer") >= 0 || firstOffline.caller.indexOf("init") >= 0)) return "AUTH_STATUS_NETWORK_FAILURE";
    if (firstOffline && !laterReadable && finalState.dataStatus === "offline") return "OFFLINE_STATE_NEVER_RECOVERED";
    return "UNKNOWN";
  }

  window.__offlineOriginReportBeforeManualRecalc = function () {
    var offline = state.transitions.filter(function (entry) { return entry.newDataStatus === "offline" || entry.newServerStatus === "offline"; });
    var firstOffline = offline[0] || null;
    var lastOffline = offline.length ? offline[offline.length - 1] : null;
    var laterReadable = !!(lastOffline && state.transitions.some(function (entry) {
      return entry.sequence > lastOffline.sequence && (entry.newDataStatus === "ready" || entry.newDataStatus === "empty");
    }));
    var finalState = currentUiState();
    var offlineOrder = lastOffline ? Number(lastOffline.lifecycleOrder || 0) : 0;
    var backendSnapshotLaterSucceeded = state.endpoints.some(function (entry) {
      return entry.ok && entry.endpoint.indexOf("/api/card_snapshot/") >= 0 && (!offlineOrder || Number(entry.lifecycleOrder || 0) > offlineOrder);
    });
    var passiveRestoreOrder = state.passiveRestore && Number(state.passiveRestore.lifecycleOrder || 0) || 0;
    var report = {
      allStatusChangingWritesSincePageStart: state.transitions.slice(),
      firstTransitionToOffline: firstOffline,
      lastTransitionToOffline: lastOffline,
      laterReadyOrEmptyTransitionOccurred: laterReadable,
      finalUiStatus: finalState.dataStatus,
      finalServerStatus: finalState.serverStatus,
      exactOriginClassification: classify(firstOffline, lastOffline, laterReadable, finalState),
      endpoints: state.endpoints.slice(),
      backendSnapshotGetLaterSucceeded: backendSnapshotLaterSucceeded,
      runtimeRowsRestoredAfterOffline: !!(lastOffline && state.restoredRows > 0 && passiveRestoreOrder > offlineOrder),
      passiveRestore: state.passiveRestore || null,
      localStorageError: state.lastLocalStorageError || null
    };
    try { console.log("[offline-origin][sequence]", report); } catch (e) {}
    return report;
  };

  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : String(input && input.url || "");
        var method = String(init && init.method || input && input.method || "GET").toUpperCase();
        return originalFetch.apply(this, arguments).then(function (response) {
          window.__offlineOriginRecordEndpoint({ endpoint: url, method: method, ok: !!response.ok, status: response.status, networkFailure: false });
          return response;
        }, function (error) {
          window.__offlineOriginRecordEndpoint({ endpoint: url, method: method, ok: false, status: null, networkFailure: true, error: String(error && error.message || error || "") });
          throw error;
        });
      };
    }
  } catch (eFetchWrap) {}

  window.addEventListener("error", function (event) {
    var error = event && (event.error || event.message);
    var text = String(error && error.message || error || "");
    if (/quota|storage/i.test(text)) window.__offlineOriginMarkLocalStorageError(error, "window.error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    var error = event && event.reason;
    var text = String(error && error.message || error || "");
    if (/quota|storage/i.test(text)) window.__offlineOriginMarkLocalStorageError(error, "window.unhandledrejection");
  });
})();
