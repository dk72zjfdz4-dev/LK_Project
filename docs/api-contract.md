# Действующий контракт API

Один origin для интерфейса и API. JSON camelCase. Ответы API с `Cache-Control: no-store`. Ошибка имеет форму `{"error":"сообщение"}`. Изменяющие запросы из браузера отправляются с того же origin. Сессия в HttpOnly cookie.

| Метод и путь | Результат |
|---|---|
| POST /api/login | JSON `{login,password}`; 200 `{profile}` и cookie. Неверные данные — 401 |
| GET /api/me | 200 `{profile}` |
| GET /api/schedule | 200 `{today,weekStart,lessons,nextWeekLessons}`. Первая неделя текущая по Москве, с понедельника. Занятия следующей недели используются для блока ближайших занятий |
| GET /api/lessons/:id | 200 `{lesson}` только для владельца. Чужое или отсутствующее занятие — 404 |
| POST /api/logout | 204 и отзыв сессии |

Профиль содержит `fullName, firstName, lastName, faculty, program, year, group, role`. Занятие: `id, date, start, end, title, room, teacher, change, cancelled`. Дата `YYYY-MM-DD`, время `HH:mm`, изменение — строка или null, признак отмены — boolean. `today` и `weekStart` — даты. Личные GET без сессии — 401. `/api/schedule` не принимает аргумент владельца.

Владельца каждой записи определяет серверная сессия.

## Данные кабинета

Профиль дополнительно содержит `role` из `student,teacher,dean`. Общий GET `/api/cabinet` возвращает доступные роли коллекции `grades, requests, dialogues, assignments, appeals, notifications` и `unreadCount`. Коллекции всегда массивы, включая пустые.

| Метод и путь | Запрос |
|---|---|
| POST /api/requests | `{type}` |
| POST /api/requests/:id/status | `{status,note}`, статус `processing,ready,rejected` |
| GET /api/dialogues/:id | `{messages}`, сообщения `{id,mine,sender,text,createdAt,read}`. Для отправленных `read` означает прочтение собеседником |
| POST /api/dialogues/:id/read | `{throughId}` отмечает сообщения до указанного включительно, `{}` — весь диалог |
| POST /api/dialogues/:id/messages | `{text}` |
| POST /api/assignments | `{enrollmentId,title,description,dueAt,maxPoints}` |
| POST /api/assignments/:id/submission | Сырые байты, Content-Type PDF/DOCX, URI-кодированное имя в `X-Filename` |
| GET /api/submissions/:id/file | Защищённое скачивание |
| POST /api/submissions/:id/review | `{points,comment}` |
| POST /api/submissions/:id/appeal | `{reason}` |
| POST /api/appeals/:id/decision | `{comment,points}`, null сохраняет прежнюю оценку |

Записи содержат:
- Успеваемость `{id,subject,semester,points,maxPoints,control,result,criteria,studentName}`. Для преподавателя `id` — назначение.
- Заявка `{id,type,status,createdAt,studentName,history:[{status,note,createdAt}]}`.
- Диалог `{id,title,unreadCount}`.
- Задание `{id,subject,studentName,title,description,dueAt,maxPoints,submission}`. Работа `{id,filename,points,comment,status}` или null.
- Пересмотр `{id,submissionId,title,reason,status,comment,oldPoints,newPoints,createdAt,decidedAt}`.
- Уведомление `{id,title,text,createdAt}`.

POST в таблице данных кабинета и POST для избранного отвечают JSON `{ok:true}`. Все POST требуют тот же origin. Для входа и выхода действуют ответы из первой таблицы. Чужой идентификатор возвращает 404, запрет роли 403. Все даты событий ISO, дедлайн принимает дату или ISO.

## Удобство кабинета

- `POST /api/appeals/:id/withdraw` с `{}` отзывает собственное обращение в статусе `pending`. Ответ `{ok:true}`. Чужое обращение — 404, конфликт перехода — 409. В кабинете появляется статус `withdrawn` и дата `withdrawnAt`. Поле `history` содержит события `{status,createdAt}`.
- `GET /api/search?q=…` возвращает `{results:[{type,title,view,id}]}`, до 30 результатов. `view` — доступный раздел, `id` — DOM id объекта или null. Поиск ограничен серверными правами и исключает переписку и вложения.
- Доступный контакт преподавателя имеет поля `{id,name,email}`. Поле `contact` в диалоге и занятии содержит такой контакт либо null. Кабинет возвращает массив `contacts`. Все адреса принадлежат `example.com`.

## Каталог и помощник

- Профиль возвращает отдельные `firstName` и `lastName`. Полное имя по-прежнему доступно в `fullName`.
- `GET /api/help` возвращает `{documents,faq}` после проверки сессии. Каталог состоит из записей `{id,title,description,fields}` и доступен студенту. FAQ ограничен ролью. Запись FAQ содержит `{id,title,text,view,target,terms}`.
- `GET /api/help?q=…` возвращает `{answer,found}`. В ответе есть `id,title,text,view,target`. Неизвестный вопрос даёт `found:false` и путь в сообщения. Вопросы не сохраняются.
- `POST /api/requests` принимает `{type}` с точным названием из каталога. Исторические заявки сохраняются. Нужен только выбор вида документа.
- Результаты поиска `document` и `faq` ведут к `document-{id}` в `requests` и `faq-{id}` через маршрут `help` соответственно. Клиент открывает FAQ в диалоге, без пункта меню.

## Библиотека

Аутентифицированный `GET /api/library` отдаёт демонстрационный каталог `{books:[{id,title,author,subject,description,favorite}]}`. Поиск по названию и автору и фильтр дисциплины применяются к этому общему каталогу на клиенте. `POST /api/library/:id/favorite` принимает `{favorite:boolean}`. Владелец избранного определяется сессией. Установка и снятие отметки идемпотентны.

## Запланированные изменения API

На следующий этап новые маршруты и изменения форматов не согласованы. Размещение с HTTPS не добавляет маршруты.
