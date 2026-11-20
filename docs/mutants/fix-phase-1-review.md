| id | файл | що ламає | очікування | результат | |
|---|---|---|---|---|---|
| R1 | `src/db/captures.ts` | «Не так» стирає ВСІ відкриті записи людини, а не лише свого захоплення (S1.6.h) | killed | KILLED (7.8 с) | ✅ |
| R3 | `src/bot.ts` | збій D1 на ensureUser без RetryableError — тихий 200, Telegram не повторить (S1.4.h) | killed | KILLED (7.7 с) | ✅ |
| N1 | `src/db/system.ts` | оренда без перевірки next_try_at: два паралельні прогони беруть одне захоплення (S1.5.c) | killed | KILLED (7.8 с) | ✅ |
| N2 | `src/time.ts` | тихі години з переходом через північ не працюють: о 02:00 бот не мовчить (S1.5.e) | killed | KILLED (8.0 с) | ✅ |
| N3 | `src/retry.ts` | gave_up лише після 7-ї невдачі замість 6-ї (S1.5.b) | killed | KILLED (8.1 с) | ✅ |
| N4 | `src/retry.ts` | за прогін береться 4 захоплення замість 3 (S1.5.g) | killed | KILLED (7.8 с) | ✅ |
| N5 | `src/retry.ts` | ліміт доби витрачає спробу (S1.5.f) | killed | KILLED (7.7 с) | ✅ |
| N6 | `src/db/captures.ts` | успішний повтор не видаляє запасну нотатку — у людини дубль (S1.5.d) | killed | KILLED (7.8 с) | ✅ |
| N7 | `src/db/system.ts` | pause_until = now ще вважається паузою (S1.5.e) | killed | KILLED (7.9 с) | ✅ |
| N8 | `src/db/system.ts` | /health.queue.pending рахує всі захоплення, а не лише pending (S1.5.h) | killed | KILLED (7.7 с) | ✅ |
| N9 | `src/note.ts` | керуючі символи лишаються в заголовку нотатки (шов 1) | killed | KILLED (7.8 с) | ✅ |
| N10 | `src/retry.ts` | розпізнане не потрапляє в розбір: ШІ отримує порожній текст (S1.7.d) | killed | KILLED (8.2 с) | ✅ |
| N11 | `src/db/captures.ts` | повтор, що не вдався, щоразу додає ще одну запасну нотатку (шов 5, S1.5.b) | killed | KILLED (7.7 с) | ✅ |
| N12 | `src/db/system.ts` | підбір ігнорує тихі години (S1.5.e) | killed | KILLED (7.8 с) | ✅ |

Підсумок: 14/14 як очікувалось. Логи: `C:\Users\USERPC~1\AppData\Local\Temp\mutate-sdgcyal5`
WRONG-KILL — тести впали, але у виводі немає `match` (впало не те). TIMEOUT вбитим не рахується.
