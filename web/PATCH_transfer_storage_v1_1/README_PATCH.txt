PATCH_transfer_storage_v1.1
Что исправляет:
- Перенос долга/пени (ключи jkh_transfer_v1 / jkh_transfer_balance_v1 / jkh_freeze_to_v1)
  теперь читается/пишется через JKHStore/JKHStorage с fallback на localStorage.
  Это устраняет кейс, когда в desktop-оболочке localStorage "пустой", и перенос не работает.

Установка:
- Заменить файлы:
  web/calc_engine.js
  web/abonent_card.html
