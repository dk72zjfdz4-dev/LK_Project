import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('roles, applications, replies, grading, appeals and persistence', { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'cabinet-workflows-'));
  const accounts = { student1: '1', student2: '2', teacher1: 'TEACHER', dean1: 'DEAN' };
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
    assert.equal((await response.json()).profile.role, role);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const student = await login('student1', 'student');
  const other = await login('student2', 'student');
  const teacher = await login('teacher1', 'teacher');
  const dean = await login('dean1', 'dean');
  const cabinet = (cookie) => expect('/cabinet', cookie);
  const initial = await cabinet(student);
  assert.ok(initial.contacts.length);
  assert.ok(initial.contacts.every(({ email }) => email.endsWith('@example.com')));
  const search = (query, cookie) => expect('/search?q=' + encodeURIComponent(query), cookie);
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
  const cancellations = [...schedule.lessons, ...schedule.nextWeekLessons].filter(({ cancelled }) => cancelled);
  assert.equal(cancellations.length, 1);
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
  const status = '/requests/' + application.id + '/status';
  await expect(status, other, { status: 'ready', note: 'Готово' }, 403);
  await expect(status, dean, { status: 'processing', note: 'Принято в работу' });
  await expect(status, dean, { status: 'ready', note: 'Справка готова' });
  const ready = (await cabinet(student)).requests.find(({ id }) => id === application.id);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.history.length >= 3);

  const dialog = initial.dialogues.find((item) => /деканат/i.test(item.title));
  assert.ok(dialog);
  const thread = '/dialogues/' + dialog.id;
  await expect(thread, other, undefined, 404);
  await expect(thread + '/messages', other, { text: 'Чужое сообщение' }, 404);
  await expect(thread + '/messages', student, { text: 'Когда можно забрать справку?' });
  assert.deepEqual((await search('Когда можно забрать справку?', student)).results, []);
  assert.ok((await expect(thread, dean)).messages.some((row) => row.text === 'Когда можно забрать справку?' && !row.mine));
  const beforeReply = (await cabinet(student)).unreadCount;
  await expect(thread + '/messages', dean, { text: 'Завтра после 14:00.' });
  assert.equal((await cabinet(student)).unreadCount, beforeReply + 1);
  const reply = (await expect(thread, student)).messages.find((row) => row.text === 'Завтра после 14:00.' && !row.mine);
  assert.equal(reply.read, false);
  await expect(thread + '/messages', dean, { text: 'Возьмите номер заявки.' });
  await expect(thread + '/read', student, { throughId: reply.id });
  const afterRead = (await expect(thread, dean)).messages;
  assert.equal(afterRead.find(({ id }) => id === reply.id).read, true);
  assert.equal(afterRead.at(-1).read, false);

  const teaching = initial.dialogues.find((item) => item.id !== dialog.id);
  assert.ok(teaching);
  const teachingThread = '/dialogues/' + teaching.id;
  await expect(teachingThread, dean, undefined, 404);
  await expect(teachingThread + '/messages', student, { text: 'Можно уточнить критерии работы?' });
  await expect(teachingThread + '/messages', teacher, { text: 'Критерии указаны в задании.' });
  const teacherReply = (await expect(teachingThread, student)).messages.find((row) => row.text === 'Критерии указаны в задании.');
  assert.ok(teacherReply);
  await expect(thread + '/read', student, { throughId: teacherReply.id }, 404);

  const enrollment = (await cabinet(teacher)).grades.find((row) => /Нюша/.test(row.studentName));
  assert.ok(enrollment);
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
  await start();
  const persisted = await cabinet(student);
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
  assert.ok((await expect(thread, student)).messages.some((row) => row.text === 'Завтра после 14:00.'));
  assert.equal((await request(submitted + '/file', student)).status, 200);
  const documentWork = persisted.assignments.find(({ id }) => id === documentTask.id).submission;
  const document = await request('/submissions/' + documentWork.id + '/file', teacher);
  assert.equal(document.status, 200);
  assert.deepEqual(Buffer.from(await document.arrayBuffer()), docx);
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
