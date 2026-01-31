/* =====================================================================
   constants.js — общие константы проекта (минимальный слой совместимости)

   Цель:
   - централизовать ключи/флаги, которые используются в разных модулях;
   - не допускать падений вида "XXX is not defined".

   Подключение:
   - добавь <script src="constants.js"></script> ПЕРЕД всеми другими .js.
   ===================================================================== */

(function (w) {
  w.JKH_CONST = w.JKH_CONST || {};
  const C = w.JKH_CONST;

  // === LocalStorage keys (ставки рефинансирования) ===
  // Обычный режим
  C.REFI_KEY_NORMAL = C.REFI_KEY_NORMAL || 'refinancing_rates_normal_v1';
  // Режим моратория (если включён)
  C.REFI_KEY_MORA = C.REFI_KEY_MORA || 'refinancing_rates_moratorium_v1';

  // === LocalStorage keys (источники оплат) ===
  C.PAYMENT_SOURCES_KEY = C.PAYMENT_SOURCES_KEY || 'payment_sources_v1';

  // Экспорт в глобальные имена для обратной совместимости
  // (если какой-то файл ожидает просто REFI_KEY_NORMAL без JK...)
  if (typeof w.REFI_KEY_NORMAL === 'undefined') w.REFI_KEY_NORMAL = C.REFI_KEY_NORMAL;
  if (typeof w.REFI_KEY_MORA === 'undefined') w.REFI_KEY_MORA = C.REFI_KEY_MORA;
  if (typeof w.PAYMENT_SOURCES_KEY === 'undefined') w.PAYMENT_SOURCES_KEY = C.PAYMENT_SOURCES_KEY;
})(window);
