| id | файл | що ламає | очікування | результат | |
|---|---|---|---|---|---|
| R3 | `src/scheduled.ts` | пінг монітора без signal — таймаут 5 с не діє (0.3.c) | killed | KILLED (4.2 с) | ✅ |
| R3b | `src/scheduled.ts` | таймер є, але abort не викликається (0.3.c) | killed | KILLED (4.2 с) | ✅ |
| R5 | `src/db/system.ts` | новий експорт без userId у system.ts (0.4.d) | killed | KILLED (3.1 с) | ✅ |
| R5b | `test/node/guard-lib.ts` | з винятків випав існуючий queueSize — список має бути точним (0.4.d) | killed | KILLED (3.8 с) | ✅ |
| S8b | `scripts/mutate.py` | прибрати перевірку брудного дерева (0.8.b) | killed | KILLED (4.4 с) | ✅ |

Підсумок: 5/5 як очікувалось. Логи: тимчасова тека прогону
WRONG-KILL — тести впали, але у виводі немає `match` (впало не те). TIMEOUT вбитим не рахується.
