| id | файл | що ламає | очікування | результат | |
|---|---|---|---|---|---|
| R2 | `src/db/system.ts` | Д2: будь-який старий рядок виду блокує доплановування -> має червоніти саме 3.1.d (з історією) | killed | KILLED (31.2 с) | ✅ |
| R3 | `src/digests/render.ts` | Д1: учорашня справа з часом показує «12:00 DDD», ніби сьогодні -> має червоніти 3.2.b | killed | KILLED (32.1 с) | ✅ |
| B1a | `src/digests/dispatch.ts` | В1: без запобіжника межі доби зайвий pending тієї ж доби відправляється -> другий огляд | killed | KILLED (32.7 с) | ✅ |
| B1b | `src/db/digests.ts` | В1: відправлений, але скасований /settings рядок лишається cancelled -> lastSentFireAt не бачить -> другий огляд | killed | KILLED (32.3 с) | ✅ |
| B1c | `src/digests/schedule.ts` | В1/тиждень: межа тижня = лише кінець доби -> тижневий огляд наступного дня після зміни дня тижня | killed | KILLED (30.8 с) | ✅ |
| D3 | `scripts/mutate.py` | Д3: match по всьому виводу (зі stderr пройдених тестів) -> хибний KILLED | killed | KILLED (2.6 с) | ✅ |

Підсумок: 6/6 як очікувалось. Логи: `C:\Users\User PC\AppData\Local\Temp\claude\9cc286406cce09ec\8e1b7eaa-124d-4bd1-98b6-e948c28e280f\scratchpad\ml-fix`
WRONG-KILL — тести впали, але у виводі немає `match` (впало не те). TIMEOUT вбитим не рахується.
