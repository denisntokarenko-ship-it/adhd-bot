| id | файл | що ламає | очікування | результат | |
|---|---|---|---|---|---|
| R5 | `src/reminders/dispatch.ts` | повтор leave_now після початку події створюється (його гасить лише leaveMoot): «ланцюг вичерпано» = sent без нащадка (2.2.b/e) ламається — В2 | killed | KILLED (14.6 с) | ✅ |
| R6 | `src/scheduled.ts` | збій відправки нагадувань зупиняє processPending (S2.3.f, борг 0.3.f) — В1 | killed | KILLED (14.6 с) | ✅ |
| R7 | `src/scheduled.ts` | збій планувальника зупиняє відправку і processPending (S2.3.f) — В1 | killed | KILLED (14.9 с) | ✅ |
| F1 | `src/reminders/plan.ts` | Б1: подія all_day знову «подія з часом» — її північ обрізає повтори, 1 відправка замість 4 | killed | KILLED (14.6 с) | ✅ |
| F2 | `src/reminders/plan.ts` | Б2: без винятку — «час виходити» чекає вікна зведення й гасне на початку події (S2.6 п.1, 2.6.g) | killed | KILLED (14.8 с) | ✅ |
| F3 | `src/reminders/dispatch.ts` | Б2: dispatch не позначає ланцюг leave_now — чиста функція має виняток, а cron ним не користується | killed | KILLED (14.7 с) | ✅ |
| F4 | `src/ai/prompt.ts` | Б3 (в): «важливо» в середині фрази знову не гарантує important | killed | KILLED (14.5 с) | ✅ |
| F5 | `src/ai/prompt.ts` | Б3 (а): час без дня знову без правила — запис без дати й без питання | killed | KILLED (14.6 с) | ✅ |
| F6 | `src/ai/prompt.ts` | Б3 (б): «у п'ятницю о 14:30», сказане в п'ятницю о 15:00, — тиша замість питання | killed | KILLED (14.7 с) | ✅ |

Підсумок: 9/9 як очікувалось. Логи: `C:\Users\USERPC~1\AppData\Local\Temp\mutate-pk5n8rao`
WRONG-KILL — тести впали, але у виводі немає `match` (впало не те). TIMEOUT вбитим не рахується.
