// === FIX: интеграция с tariffs_{owner} ===

function getOwnerId(){
  try{
    if (window.JKHStorage && typeof JKHStorage.getActiveOwnerId === "function"){
      return String(JKHStorage.getActiveOwnerId() || "").trim();
    }
    if (window.Auth && typeof Auth.getActiveDbOwnerId === "function"){
      return String(Auth.getActiveDbOwnerId() || "").trim();
    }
  }catch(e){}
  return "";
}

function loadTariffsFromServerFirst(){
  try{
    const owner = getOwnerId();
    if (!owner) return [];

    const raw = JKHStore.getRaw("tariffs_" + owner);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed;
  }catch(e){
    console.warn("tariffs load fail", e);
    return [];
  }
}

// === конвертация в формат движка ===
function convertTariffsToInternal(tariffs){
  const result = [];

  tariffs.forEach(t => {
    if (!t.active) return;

    const isPerM2 = t.type === "per_m2";
    const isFixed = t.type === "fixed_month";

    (t.rates || []).forEach(r => {
      if (!r.from) return;

      const from = r.from;
      const value = Number(r.value) || 0;

      result.push({
        from,
        content: isPerM2 ? value : 0,
        repair: 0,
        fixed: isFixed ? value : 0
      });
    });
  });

  result.sort((a,b)=>String(a.from).localeCompare(String(b.from)));
  return result;
}

// === ПЕРЕОПРЕДЕЛЯЕМ старую функцию ===
function detectTariffTable(){
  const raw = loadTariffsFromServerFirst();
  return convertTariffsToInternal(raw);
}

// === фикс/мес из нового формата ===
function fixedSumForMonthProRated(month, year){
  const tariffs = loadTariffsFromServerFirst();

  const y = Number(year);
  const m = Number(month);

  let total = 0;

  tariffs.forEach(t => {
    if (!t.active) return;
    if (t.type !== "fixed_month") return;

    let chosen = null;

    (t.rates || []).forEach(r => {
      if (!r.from) return;
      if (!chosen || r.from >= chosen.from) chosen = r;
    });

    if (chosen){
      total += Number(chosen.value) || 0;
    }
  });

  return Math.round(total * 100) / 100;
}