# CRITICAL_DO_NOT_TOUCH.md

## КРИТИЧЕСКИЕ ЗАПРЕТЫ

❌ Нельзя удалять transfer_events  
❌ Нельзя пересчитывать пеню старому абоненту после freeze_to  
❌ Нельзя использовать new Date("YYYY-MM-DD")  
❌ Нельзя переносить долг без фиксации события TRANSFER  
❌ Нельзя модифицировать calc_engine.js без проверки TRANSFER  

## ОБЯЗАТЕЛЬНО
✔ transfer_balance должен сохраняться  
✔ история передач у обоих абонентов  
✔ соблюдение CANON TRANSFER v18

Любые правки только через LOGIC_SPEC.