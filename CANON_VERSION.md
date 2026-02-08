# CANON_VERSION

Project: ПАПАЖКХ  
Version: v1.8.1  
Status: ETALON (зафиксировано, docs synced)  
Date: 2026-02-08

## CANON TRANSFER v18
- Передача задолженности и пени между абонентами работает корректно
- WITH_DEBT: долг и пеня переходят, пеня продолжает расти у нового абонента
- WITHOUT_DEBT: новый абонент с нуля, старый замораживается
- freeze_to = transfer_date - 1 день

## Ключевые файлы
- web/abonent_card.html — CANON TRANSFER v18
- web/calc_engine.js — CANON TRANSFER v18
- web/new_abonent.html — syntax fixed

## Проверка
1. Создать нового абонента на квартиру с долгом
2. Выбрать режим WITH_DEBT
3. Проверить перенос долга и рост пени
