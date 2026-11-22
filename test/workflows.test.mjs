import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('roles, applications, replies, grading, appeals and persistence', { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'cabinet-workflows-'));
  const accounts = { student1: '1', student2: '2', teacher1: 'TEACHER', dekanat1: 'DEAN' };
  const passwords = Object.fromEntries(Object.keys(accounts).map((login) => [login, randomBytes(20).toString('base64url')]));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', DB_PATH: join(folder, 'test.sqlite') };
  for (const [login, slot] of Object.entries(accounts)) env['DEMO_PASSWORD_' + slot] = passwords[login];

  let server;
  let exit;
  let origin;
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], { env });
    exit = once(server, 'exit');
    let diagnostics = '';
    let output = '';
    server.stderr.on('data', (chunk) => { diagnostics += chunk; });
    origin = await new Promise((resolve, reject) => {
      server.stdout.on('data', (chunk) => {
        output += chunk;
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) resolve(url);
      });
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Startup (${code}) failed: ${diagnostics}`)));
    });
  }

  async function stop() {
    if (!server) return;
    server.kill();
    await exit;
    server = null;
  }
  t.after(async () => {
    await stop();
    await rm(folder, { recursive: true, force: true });
  });
  await start();

  async function request(path, cookie, body, overrideHeaders = {}) {
    const headers = { ...overrideHeaders };
    if (cookie) headers.Cookie = cookie;
    if (body === undefined) return fetch(origin + '/api' + path, { headers });
    headers.Origin = origin;
    if (!Buffer.isBuffer(body)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(origin + '/api' + path, { method: 'POST', headers, body });
  }

  async function expect(path, cookie, body, status = 200) {
    const response = await request(path, cookie, body);
    const data = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
    return data;
  }

  const login = async (name, role) => {
    const response = await request('/login', null, { login: name, password: passwords[name] });
    assert.equal(response.status, 200, name);
    const { profile } = await response.json();
    assert.equal(profile.role, role);
    const initials = { student1: 'НР', student2: 'КР', teacher1: 'СС', dekanat1: 'ИЯ' };
    assert.equal(profile.firstName[0] + profile.lastName[0], initials[name]);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const student = await login('student1', 'student');
  const other = await login('student2', 'student');
  const teacher = await login('teacher1', 'teacher');
  const dean = await login('dekanat1', 'dean');
  const cabinet = (cookie) => expect('/cabinet', cookie);
  const initial = await cabinet(student);
  await expect('/library', null, undefined, 401);
  const { books } = await expect('/library', student);
  assert.equal(books.length, 9);
  const bookPath = '/library/' + books[0].id + '/favorite';
  await expect(bookPath, student, { favorite: 'true' }, 400);
  await expect('/library/999/favorite', student, { favorite: true }, 404);
  await expect(bookPath, student, { favorite: true, accountId: 2 });
  assert.equal((await expect('/library', other)).books[0].favorite, false);
  assert.ok(initial.contacts.length);
  assert.ok(initial.contacts.every(({ email }) => email.endsWith('@example.com')));
  const sinistra = initial.contacts.filter(({ name }) => name === 'Аврора Синистра');
  assert.equal(sinistra.length, 1);
  const minerva = initial.contacts.filter(({ name }) => name === 'Минерва Макгонагалл');
  assert.equal(minerva.length, 1);
  assert.equal(sinistra[0].teacherId, null);
  const office = initial.contacts.find(({ role }) => role === 'dean');
  assert.equal(office.email, 'dean-office@example.com');
  const search = (query, cookie) => expect('/search?q=' + encodeURIComponent(query), cookie);
  await expect('/help', null, undefined, 401);
  const { documents, faq } = await expect('/help', student);
  assert.equal(documents.length, 8);
  assert.equal(new Set(documents.map(({ title }) => title)).size, 8);
  assert.ok(faq.length);
  for (const cookie of [teacher, dean]) {
    assert.deepEqual((await expect('/help', cookie)).documents, []);
    assert.ok(!(await search('справ', cookie)).results.some(({ type }) => type === 'document'));
  }
  const partial = (await search('справ', student)).results;
  assert.ok(partial.some(({ type, view }) => type === 'section' && view === 'requests'));
  assert.ok(partial.filter(({ type }) => type === 'document').length >= 6);
  assert.ok(partial.some(({ type, view }) => type === 'faq' && view === 'help'));
  const question = (text) => expect('/help?q=' + encodeURIComponent(text), student);
  const documentAnswer = await question('Как получить справку об обучении?');
  assert.equal(documentAnswer.found, true);
  assert.equal(documentAnswer.answer.target, 'document-enrollment');
  const unknown = await question('Как варить борщ?');
  assert.equal(unknown.found, false);
  assert.equal(unknown.answer.view, 'messages');
  await expect('/requests', student, { type: 'Справка вне каталога' }, 400);
  assert.ok((await search('Зельеварение', student)).results.some(({ view }) => view === 'grades'));
  assert.deepEqual((await search('Зельеварение', dean)).results, []);
  assert.ok((await search('Карта кампуса', dean)).results.some(({ view }) => view === 'campus'));
  const contact = initial.contacts[0];
  assert.ok((await search(contact.email, student)).results.some(({ id }) => id === 'contact-' + contact.id));
  assert.match((await expect('/me', student)).profile.fullName, /Нюша/);
  assert.ok(new Set(initial.grades.map((grade) => grade.semester)).size >= 2);
  assert.ok(initial.notifications.some(({ title }) => /отменено/i.test(title)));
  assert.ok(!(await cabinet(other)).notifications.some(({ title }) => /отменено/i.test(title)));
  const schedule = await expect('/schedule', student);
  const officeChat = await expect('/dialogues/contact/' + office.partnerId, student, {});
  assert.equal(officeChat.dialogueId, initial.dialogues.find(({ partnerRole }) => partnerRole === 'dean').id);
  await expect('/dialogues/teacher/' + sinistra[0].partnerId, student, {}, 404);
  const catalogueChat = await expect('/dialogues/contact/' + sinistra[0].partnerId, student, {});
  assert.ok((await cabinet(student)).dialogues.some(({ id }) => id === catalogueChat.dialogueId));
  assert.ok(schedule.lessons.some(({ contact }) => contact?.id === minerva[0].id && contact.partnerId === minerva[0].partnerId));
  const registered = initial.contacts.find((contact) => Number.isSafeInteger(contact.teacherId));
  assert.ok(registered);
  assert.ok(schedule.lessons.some(({ contact }) => contact?.teacherId === registered.teacherId));
  assert.ok(initial.contacts.some((contact) => contact.teacherId === null));
  const startTeacherChat = '/dialogues/teacher/' + registered.teacherId;
  const teacherChat = await expect(startTeacherChat, student, {});
  assert.equal((await expect(startTeacherChat, student, {})).dialogueId, teacherChat.dialogueId);
  assert.ok(initial.dialogues.some(({ id, fullName }) => id === teacherChat.dialogueId && fullName === registered.name));
  await expect(startTeacherChat, dean, {}, 403);
  await expect('/dialogues/teacher/999999', student, {}, 404);
  const november = (await expect('/schedule?month=2026-11', student)).lessons;
  assert.ok(november.filter(({ date }) => date >= '2026-11-03' && date <= '2026-11-19')
    .every(({ change, cancelled }) => change === null && !cancelled));
  const cancellations = november.filter(({ cancelled }) => cancelled);
  assert.deepEqual(cancellations.map(({ date }) => date), ['2026-11-26']);
  const restored = november.find(({ date, title }) => date === '2026-11-19' && title === 'Зельеварение');
  assert.equal((await expect('/lessons/' + restored.id, student)).lesson.change, null);
  assert.equal((await expect('/lessons/' + cancellations[0].id, student)).lesson.cancelled, true);
  assert.equal((await expect('/schedule', other)).lessons.some(({ cancelled }) => cancelled), false);

  await expect('/requests', student, { type: 'Справка об обучении' });
  const application = (await cabinet(student)).requests.find(({ id }) => !initial.requests.some((row) => row.id === id));
  assert.ok(application);
  const requestHit = ({ id }) => id === 'request-' + application.id;
  assert.ok((await search('Справка об обучении', student)).results.some(requestHit));
  assert.ok(!(await search('Справка об обучении', other)).results.some(requestHit));
  assert.ok(!(await cabinet(other)).requests.some(({ id }) => id === application.id));
  assert.ok(!(await cabinet(teacher)).requests.some(({ id }) => id === application.id));
  assert.ok((await cabinet(dean)).requests.some(({ id }) => id === application.id));
  const certificate = '/requests/' + application.id;
  await expect(certificate + '/pdf', student, undefined, 404);
  await expect(certificate + '/print', student, undefined, 404);
  const status = certificate + '/status';
  await expect(status, other, { status: 'ready', note: 'Готово' }, 403);
  await expect(status, dean, { status: 'processing', note: 'Принято в работу' });
  await expect(status, dean, { status: 'ready', note: 'Справка готова' });
  const ready = (await cabinet(student)).requests.find(({ id }) => id === application.id);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.history.length >= 3);
  await expect(certificate + '/pdf', other, undefined, 404);
  await expect(certificate + '/print', other, undefined, 404);
  await expect(certificate + '/pdf', dean, undefined, 403);
  await expect(certificate + '/pdf', null, undefined, 401);
  const certificateResponse = await request(certificate + '/pdf', student);
  assert.equal(certificateResponse.status, 200);
  assert.equal(certificateResponse.headers.get('content-type'), 'application/pdf');
  assert.match(certificateResponse.headers.get('content-disposition'), /^attachment;/);
  assert.equal(certificateResponse.headers.get('cache-control'), 'no-store');
  const pdfData = Buffer.from(await certificateResponse.arrayBuffer()).toString('latin1');
  assert.match(pdfData, /^%PDF-/);
  assert.match(pdfData, /MediaBox \[0 0 595\.28 841\.89\]/);
  const print = await request(certificate + '/print', student);
  assert.equal(print.status, 200);
  assert.match(print.headers.get('content-type'), /^text\/html/);
  assert.equal(print.headers.get('cache-control'), 'no-store');
  const printHtml = await print.text();
  assert.match(printHtml, /Демонстрационный документ. Не является официальной справкой/);
  assert.match(printHtml, /Нюша Мироновна Романова/);
  assert.match(printHtml, /Справка об обучении/);
  for (const item of documents.filter(({ title }) => title !== application.type)) {
    await expect('/requests', student, { type: item.title });
  }

  const dialog = initial.dialogues.find((item) => /деканат/i.test(item.title));
  assert.ok(dialog);
  assert.equal(dialog.contact.email, 'dean-office@example.com');
  const deanStudentContact = (await cabinet(dean)).dialogues.find(({ id }) => id === dialog.id).contact;
  assert.equal(deanStudentContact.name, (await expect('/me', student)).profile.fullName);
  assert.match(deanStudentContact.email, /@example\.com$/);
  const thread = '/dialogues/' + dialog.id;
  await expect(thread, other, undefined, 404);
  await expect(thread + '/messages', other, { text: 'Чужое сообщение' }, 404);
  await expect(thread + '/messages', student, { text: 'Когда можно забрать справку?' });
  assert.deepEqual((await search('Когда можно забрать справку?', student)).results, []);
  assert.ok((await expect(thread, dean)).messages.some((row) => row.text === 'Когда можно забрать справку?' && !row.mine));
  const beforeReply = (await cabinet(student)).unreadCount;
  const replyDraft = { text: 'Завтра после 14:00.', clientId: 'workflow-retry-' + randomBytes(12).toString('hex') };
  const sent = await expect(thread + '/messages', dean, replyDraft);
  const retried = await expect(thread + '/messages', dean, replyDraft);
  assert.equal(sent.message.id, retried.message.id);
  await expect(thread + '/messages', dean, { ...replyDraft, text: 'Другой текст' }, 409);
  assert.equal((await cabinet(student)).unreadCount, beforeReply + 1);
  const reply = (await expect(thread, student)).messages.find((row) => row.text === 'Завтра после 14:00.' && !row.mine);
  assert.equal(reply.read, false);
  assert.equal(reply.delivered, false);
  await expect(thread + '/delivered', other, { messageIds: [reply.id] }, 404);
  await expect(thread + '/read', other, { messageIds: [reply.id] }, 404);
  await expect(thread + '/read', dean, { messageIds: [reply.id] }, 404);
  await expect(thread + '/delivered', student, { messageIds: [reply.id] });
  const delivered = (await expect(thread, dean)).messages.find(({ id }) => id === reply.id);
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.read, false);
  await expect(thread + '/messages', dean, { text: 'Возьмите номер заявки.' });
  await expect(thread + '/read', student, { messageIds: [reply.id] });
  const afterRead = (await expect(thread, dean)).messages;
  assert.equal(afterRead.find(({ id }) => id === reply.id).read, true);
  assert.equal(afterRead.at(-1).read, false);
  await expect(thread + '/delivered', student, { messageIds: [reply.id] });
  assert.equal((await expect(thread, dean)).messages.find(({ id }) => id === reply.id).read, true);

  const teaching = initial.dialogues.find((item) => item.id !== dialog.id);
  assert.ok(teaching);
  const teacherStudentContact = (await cabinet(teacher)).dialogues.find(({ id }) => id === teaching.id).contact;
  assert.equal(teacherStudentContact.email, deanStudentContact.email);
  const teachingThread = '/dialogues/' + teaching.id;
  await expect(teachingThread, dean, undefined, 404);
  await expect(teachingThread + '/messages', student, { text: 'Можно уточнить критерии работы?' });
  await expect(teachingThread + '/messages', teacher, { text: 'Критерии указаны в задании.' });
  const teacherReply = (await expect(teachingThread, student)).messages.find((row) => row.text === 'Критерии указаны в задании.');
  assert.ok(teacherReply);
  await expect(thread + '/read', student, { messageIds: [teacherReply.id] }, 404);

  const enrollment = (await cabinet(teacher)).grades.find((row) => /Нюша/.test(row.studentName));
  assert.ok(enrollment);
  const originalGrade = initial.grades.find(({ subject, semester }) => subject === enrollment.subject && semester === enrollment.semester);
  assert.ok(originalGrade);
  const relatedWork = initial.assignments.filter(({ enrollmentId }) => enrollmentId === originalGrade.id);
  assert.ok(relatedWork.length > 1);
  assert.equal(originalGrade.points, originalGrade.courseworkPoints + relatedWork.reduce((sum, task) => (
    sum + (task.submission?.status === 'reviewed' ? task.submission.points : 0)
  ), 0));
  assert.equal(originalGrade.maxPoints, originalGrade.courseworkMax + relatedWork.reduce((sum, task) => sum + task.maxPoints, 0));
  const unrelatedEnrollment = initial.grades.find((row) => row.id !== enrollment.id);
  const assignmentTitle = 'Контрольная работа для проверки';
  const dueAt = new Date(Date.now() + 7 * 86400000).toISOString();
  await expect('/assignments', teacher, {
    enrollmentId: unrelatedEnrollment.id, title: assignmentTitle, description: 'Подготовьте краткий отчёт.', dueAt, maxPoints: 10,
  }, 404);
  await expect('/assignments', teacher, {
    enrollmentId: enrollment.id, title: assignmentTitle, description: 'Подготовьте краткий отчёт.', dueAt, maxPoints: 10,
  });
  const assignment = (await cabinet(student)).assignments.find((item) => item.title === assignmentTitle);
  assert.ok(assignment);
  assert.ok((await search(assignmentTitle, student)).results.some(({ id }) => id === 'assignment-' + assignment.id));
  assert.deepEqual((await search(assignmentTitle, other)).results, []);
  const upload = '/assignments/' + assignment.id + '/submission';
  const pdf = tinyPdf();
  const fileHeaders = { 'Content-Type': 'application/pdf', 'X-Filename': 'report.pdf' };
  assert.equal((await request(upload, other, pdf, fileHeaders)).status, 404);
  const rejected = await request(upload, student, Buffer.from('plain text'), fileHeaders);
  assert.ok([400, 415, 422].includes(rejected.status));
  const oversized = await request(upload, student, Buffer.alloc(10 * 1024 * 1024 + 1), fileHeaders);
  assert.equal(oversized.status, 413);
  assert.ok((await request(upload, student, pdf, fileHeaders)).ok);
  const submission = (await cabinet(student)).assignments.find(({ id }) => id === assignment.id).submission;
  assert.ok(submission);
  const submitted = '/submissions/' + submission.id;
  assert.equal((await request(submitted + '/file', null)).status, 401);
  for (const cookie of [other, dean]) {
    assert.ok([403, 404].includes((await request(submitted + '/file', cookie)).status));
  }
  const download = await request(submitted + '/file', teacher);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/i);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  await expect(submitted + '/review', teacher, { points: 11, comment: 'Вне допустимой шкалы.' }, 400);
  await expect(submitted + '/review', teacher, { points: 7, comment: 'Не хватает вывода.' });
  const initialGrade = initial.grades.find(({ id }) => id === enrollment.id);
  const gradeAfterReview = () => cabinet(student).then(({ grades }) => grades.find(({ id }) => id === enrollment.id));
  assert.equal((await gradeAfterReview()).points, initialGrade.points + 7);

  await expect(submitted + '/appeal', student, { reason: 'Вывод есть в последнем абзаце.' });
  assert.equal((await gradeAfterReview()).points, initialGrade.points + 7);
  const appeal = (await cabinet(teacher)).appeals.find((item) => item.submissionId === submission.id);
  assert.ok(appeal);
  await expect('/appeals/' + appeal.id + '/withdraw', other, {}, 404);
  await expect('/appeals/' + appeal.id + '/decision', teacher, { comment: 'Вывод подтверждён.', points: 9 });
  await expect('/appeals/' + appeal.id + '/withdraw', student, {}, 409);
  assert.equal((await gradeAfterReview()).points, initialGrade.points + 9);

  const reviewed = initial.assignments.find(({ submission }) => submission?.status === 'reviewed').submission;
  await expect('/submissions/' + reviewed.id + '/appeal', student, { reason: 'Проверка отзыва.' });
  const pending = (await cabinet(student)).appeals.find(({ submissionId }) => submissionId === reviewed.id);
  await expect('/appeals/' + pending.id + '/withdraw', student, {});
  await expect('/appeals/' + pending.id + '/decision', teacher, { comment: 'Позднее решение.', points: 1 }, 409);
  assert.equal((await gradeAfterReview()).points, initialGrade.points + 9);

  const otherWork = (await cabinet(other)).assignments.find(({ submission }) => submission?.status === 'reviewed').submission;
  await expect('/submissions/' + otherWork.id + '/appeal', other, { reason: 'Проверка одновременного перехода.' });
  const otherAppeal = (await cabinet(other)).appeals.find(({ submissionId }) => submissionId === otherWork.id);
  const concurrent = await Promise.all([
    request('/appeals/' + otherAppeal.id + '/withdraw', other, {}),
    request('/appeals/' + otherAppeal.id + '/decision', teacher, { comment: 'Проверено.', points: otherWork.points }),
  ]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);

  const documentTitle = 'Работа в формате DOCX';
  await expect('/assignments', teacher, {
    enrollmentId: enrollment.id, title: documentTitle, description: 'Приложите документ.', dueAt, maxPoints: 5,
  });
  const documentTask = (await cabinet(student)).assignments.find(({ title }) => title === documentTitle);
  const docx = await readFile(new URL('./fixtures/work.docx', import.meta.url));
  const docxHeaders = {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'X-Filename': encodeURIComponent('Текст работы.docx'),
  };
  assert.ok((await request('/assignments/' + documentTask.id + '/submission', student, docx, docxHeaders)).ok);

  await stop();
  const legacyDb = new DatabaseSync(env.DB_PATH);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    DELETE FROM lessons WHERE id IN (SELECT lesson_id FROM lesson_week_parity WHERE parity = 0);
    DELETE FROM lesson_week_parity;
    UPDATE students SET login = 'dean1' WHERE login = 'dekanat1';
    UPDATE lessons SET teacher = 'Прежний преподаватель';
    UPDATE students SET full_name = 'Мария Ланская' WHERE login = 'teacher1';
    UPDATE students SET full_name = 'Даниил Андреевич Речин' WHERE login = 'student2';
    DELETE FROM students WHERE directory_only = 1;
    UPDATE assignments SET due_at = '2026-11-21T20:00:00.000Z' WHERE title = 'Отчёт по практикуму';
    UPDATE students SET student_group = 'МО-24-02' WHERE login = 'student1';
    UPDATE students SET student_group = 'МЭ-23-04' WHERE login = 'student2';
    UPDATE portfolio_dean_groups SET student_group = 'МО-24-02' WHERE student_group = 'ГР-24-02';
    DROP TABLE hidden_messages;
    ALTER TABLE messages DROP COLUMN deleted_for_all;
    PRAGMA user_version = 7;
  `);
  legacyDb.close();
  await start();
  await expect('/login', null, { login: 'dean1', password: passwords.dekanat1 }, 401);
  await login('dekanat1', 'dean');
  assert.equal((await expect('/me', dean)).profile.role, 'dean');
  const expectedTeachers = new Map([
    ['Астрономия', 'Аврора Синистра'],
    ['Заклинания', 'Филиус Флитвик'],
    ['Защита от тёмных искусств', 'Римус Люпин'],
    ['Зельеварение', 'Северус Снегг'],
    ['Травология', 'Помона Стебль'],
    ['Трансфигурация', 'Минерва Макгонагалл'],
  ]);
  for (const cookie of [student, other]) {
    const { lessons, nextWeekLessons } = await expect('/schedule', cookie);
    assert.deepEqual(new Set(lessons.map(({ title }) => title)), new Set(expectedTeachers.keys()));
    for (const { title, teacher: name } of [...lessons, ...nextWeekLessons]) {
      assert.equal(name, expectedTeachers.get(title));
    }
  }
  assert.equal((await expect('/me', teacher)).profile.fullName, 'Северус Снегг');
  const persisted = await cabinet(student);
  for (const snapshot of [persisted, await cabinet(other)]) {
    assert.equal(snapshot.assignments.find(({ title }) => title === 'Отчёт по практикуму').dueAt,
      '2026-12-20T20:59:59.000Z');
  }
  assert.equal((await expect('/library', student)).books[0].favorite, true);
  await expect(bookPath, student, { favorite: false });
  assert.equal((await expect('/library', student)).books[0].favorite, false);
  assert.ok(documents.every(({ title }) => persisted.requests.some(({ type }) => type === title)));
  const withdrawn = persisted.appeals.find(({ id }) => id === pending.id);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.ok(withdrawn.withdrawnAt);
  assert.deepEqual(withdrawn.history.map(({ status }) => status), ['pending', 'withdrawn']);
  assert.equal(persisted.requests.find(({ id }) => id === application.id).status, 'ready');
  assert.equal(persisted.assignments.find(({ id }) => id === assignment.id).submission.points, 9);
  const decision = persisted.appeals.find(({ id }) => id === appeal.id);
  assert.equal(decision.oldPoints, 7);
  assert.equal(decision.newPoints, 9);
  assert.equal(decision.comment, 'Вывод подтверждён.');
  const persistedReply = (await expect(thread, student)).messages.find((row) => row.text === 'Завтра после 14:00.');
  assert.equal(persistedReply.delivered, true);
  assert.equal(persistedReply.read, true);
  assert.equal((await request(submitted + '/file', student)).status, 200);
  const documentWork = persisted.assignments.find(({ id }) => id === documentTask.id).submission;
  const document = await request('/submissions/' + documentWork.id + '/file', teacher);
  assert.equal(document.status, 200);
  assert.deepEqual(Buffer.from(await document.arrayBuffer()), docx);
  const studentDirectory = persisted.dialogueContacts.filter(({ partnerRole }) => partnerRole === 'student');
  assert.equal(studentDirectory.length, 8);
  assert.ok(studentDirectory.every(({ roleLabel, studentProfile }) => roleLabel === 'Студент' && studentProfile === undefined));
  const migrated = new DatabaseSync(env.DB_PATH, { readOnly: true });
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 16);
  assert.deepEqual(migrated.prepare('SELECT student_group FROM portfolio_dean_groups').all().map(({ student_group }) => student_group), ['ГР-24-02']);
  migrated.close();
  const peer = studentDirectory.find(({ title }) => title === 'Крош Андреевич Речин');
  assert.ok(peer);
  const otherProfile = (await expect('/me', other)).profile;
  assert.equal(otherProfile.fullName, peer.title);
  assert.equal(otherProfile.faculty, 'Слизерин');
  assert.equal((await expect('/me', student)).profile.faculty, 'Гриффиндор');
  const hedgehog = studentDirectory.find(({ title }) => title === 'Ёжик Павлович Иголкин');
  assert.ok(hedgehog);
  await expect('/login', null, { login: 'directory:yozhik', password: passwords.student1 }, 401);
  const { dialogueId: directoryThread } = await expect('/dialogues/contact/' + hedgehog.partnerId, student, {});
  await expect('/dialogues/' + directoryThread + '/messages', student, { text: 'Привет, Ёжик!' });
  assert.deepEqual((await cabinet(student)).dialogues.find(({ id }) => id === directoryThread).studentProfile, {
    faculty: 'Когтевран', program: 'Древние руны', group: 'КО-24-01', year: 2,
  });
  await expect('/dialogues/' + directoryThread, other, undefined, 404);
  const mcgonagall = persisted.dialogueContacts.find(({ title }) => title === 'Минерва Макгонагалл');
  assert.ok(mcgonagall);
  const peerPath = '/dialogues/contact/' + peer.partnerId;
  const { dialogueId: peerThread } = await expect(peerPath, student, {});
  const reverse = (await cabinet(other)).dialogueContacts.find(({ title }) => title === 'Нюша Мироновна Романова');
  assert.equal((await expect('/dialogues/contact/' + reverse.partnerId, other, {})).dialogueId, peerThread);
  for (const cookie of [student, other]) {
    const { dialogues, dialogueContacts } = await cabinet(cookie);
    const peerDialogue = dialogues.find(({ id }) => id === peerThread);
    assert.equal(peerDialogue.contact, null);
    assert.equal(peerDialogue.roleLabel, 'Студент');
    assert.deepEqual(peerDialogue.studentProfile, cookie === student
      ? { faculty: 'Слизерин', program: 'Зельеварение и алхимия', group: 'СЛ-23-04', year: 3 }
      : { faculty: 'Гриффиндор', program: 'Защита от тёмных искусств', group: 'ГР-24-02', year: 2 });
    assert.ok(dialogueContacts.every((entry) => !('email' in entry)));
  }
  assert.ok(!(await cabinet(dean)).dialogues.some(({ id }) => id === peerThread));
  await expect('/dialogues/' + peerThread, dean, undefined, 404);
  await expect('/dialogues/' + peerThread + '/messages', student, { text: 'Первое сообщение студенту', clientId: randomBytes(12).toString('hex') });
  const peerMessages = await expect('/dialogues/' + peerThread, other);
  assert.equal(peerMessages.messages[0].text, 'Первое сообщение студенту');
  const mcgonagallPath = '/dialogues/contact/' + mcgonagall.partnerId;
  await expect(mcgonagallPath, null, {}, 401);
  await expect('/dialogues/contact/' + reverse.partnerId, student, {}, 404);
  const { dialogueId: teacherThread } = await expect(mcgonagallPath, student, {});
  assert.equal((await expect(mcgonagallPath, student, {})).dialogueId, teacherThread);
  const { dialogueId: otherTeacherThread } = await expect(mcgonagallPath, other, {});
  assert.notEqual(otherTeacherThread, teacherThread);
  await expect('/dialogues/' + teacherThread, other, undefined, 404);
  const teacherDirectory = (await cabinet(teacher)).dialogueContacts;
  assert.equal(teacherDirectory.filter(({ partnerRole }) => partnerRole === 'student').length, 9);
  const deanEntry = teacherDirectory.find(({ partnerRole }) => partnerRole === 'dean');
  const firstStudent = teacherDirectory.find(({ partnerId }) => partnerId === reverse.partnerId);
  assert.ok(firstStudent);
  assert.equal((await expect('/dialogues/contact/' + firstStudent.partnerId, teacher, {})).dialogueId, teaching.id);
  const { dialogueId: staffThread } = await expect('/dialogues/contact/' + deanEntry.partnerId, teacher, {});
  const deanDirectory = (await cabinet(dean)).dialogueContacts;
  const snape = deanDirectory.find(({ fullName }) => fullName === 'Северус Снегг');
  assert.equal((await expect('/dialogues/contact/' + snape.partnerId, dean, {})).dialogueId, staffThread);
  await expect('/dialogues/' + staffThread, student, undefined, 404);
});

function tinyPdf() {
  let source = '%PDF-1.4\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  const offsets = objects.map((object, index) => {
    const offset = source.length;
    source += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  const crossReference = source.length;
  source += 'xref\n0 4\n0000000000 65535 f \n';
  for (const offset of offsets) source += String(offset).padStart(10, '0') + ' 00000 n \n';
  source += 'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n' + crossReference + '\n%%EOF\n';
  return Buffer.from(source);
}
