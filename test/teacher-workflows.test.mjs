import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('teacher lesson changes, journal lifetime, publication ownership and contacts', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cabinet-teacher-test-'));
  const path = join(directory, 'db.sqlite');
  const passwords = Array.from({ length: 4 }, () => randomBytes(18).toString('base64url'));
  const server = spawn(process.execPath, ['server.mjs'], {
    env: {
      HOST: '127.0.0.1', PORT: '0', DB_PATH: path,
      DEMO_PASSWORD_1: passwords[0], DEMO_PASSWORD_TEACHER: passwords[1], DEMO_PASSWORD_MCGONAGALL: passwords[2],
      DEMO_PASSWORD_2: passwords[3],
    },
  });
  let stderr = '';
  let db;
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  const stopped = once(server, 'close');
  t.after(async () => {
    db?.close();
    server.kill();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Server exited (${code}): ${stderr}`)));
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const ready = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (ready) resolve(ready);
    });
  });
  const post = (route, body, cookie) => fetch(origin + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(body),
  });
  async function login(login, password) {
    const response = await post('/api/login', { login, password });
    assert.equal(response.status, 200);
    const { profile } = await response.json();
    return { profile, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
  }
  const [student, teacher, other, secondStudent] = await Promise.all(
    ['student1', 'teacher1', 'teacher2', 'student2'].map((loginName, index) => login(loginName, passwords[index])),
  );
  async function get(route, account, status = 200) {
    const response = await fetch(origin + route, { headers: { Cookie: account.cookie } });
    assert.equal(response.status, status);
    return response.json();
  }
  async function write(route, body, account = teacher, status = 200) {
    const response = await post(route, body, account.cookie);
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  const week = '/api/teacher/schedule?week=2026-11-23';
  const baseline = await get(week, teacher);
  const lesson = baseline.lessons.find((item) => item.group === student.profile.group && item.status === 'scheduled');
  assert.ok(lesson);
  assert.ok(baseline.lessons.every((item) => item.title === teacher.profile.program));
  assert.deepEqual((await get(week, other)).lessons, []);
  await get(week, student, 403);
  const loc = '/api/teacher/lessons/' + lesson.id + '/change';
  await write(loc, { action: 'cancel' }, other, 404);
  const teacherBusy = baseline.lessons.find((slot) => slot.id !== lesson.id && slot.status === 'scheduled');
  assert.ok(teacherBusy);
  const teacherConflict = await write(loc, {
    action: 'move', date: teacherBusy.date, start: teacherBusy.start, end: teacherBusy.end, room: 'Онлайн',
  }, teacher, 409);
  assert.match(teacherConflict.error, /преподавателя/);
  const studentWeek = '/api/schedule?week=2026-11-23';
  const studentSchedule = (await get(studentWeek, student)).selectedWeek.lessons;
  const secondSchedule = (await get(studentWeek, secondStudent)).selectedWeek.lessons;
  const roomBusy = secondSchedule.find((slot) => !slot.cancelled && [...baseline.lessons, ...studentSchedule].every((item) =>
    item.date !== slot.date || item.status === 'cancelled' || item.cancelled || item.start >= slot.end || item.end <= slot.start));
  assert.ok(roomBusy);
  const roomConflict = await write(loc, {
    action: 'move', date: roomBusy.date, start: roomBusy.start, end: roomBusy.end, room: roomBusy.room,
  }, teacher, 409);
  assert.match(roomConflict.error, /аудитория/);

  const contacts = await get('/api/teacher/contacts', teacher);
  const contact = contacts.contacts.find((item) => item.name === student.profile.fullName);
  assert.ok(contacts.groups.includes(student.profile.group));
  assert.ok(contacts.contacts.some((item) => item.role === 'dean'));
  const contactRoute = '/api/teacher/contacts/' + contact.id + '/dialogue';
  const opened = await write(contactRoute, {});
  assert.equal((await write(contactRoute, {})).dialogueId, opened.dialogueId);
  await write(contactRoute, {}, other, 404);

  // A second enrollment in the same temporary demo group exercises partial publication and independent deadlines.
  db = new DatabaseSync(path);
  const group = student.profile.group;
  db.prepare("UPDATE students SET student_group = ? WHERE login = 'student2'").run(group);
  const journalRoute = '/api/teacher/journal/' + lesson.id;
  const grades = async () => (await get('/api/cabinet', student)).grades.find((row) => row.subject === lesson.title && row.semester === 2);
  const initialPoints = (await grades()).points;
  const journal = await get(journalRoute, teacher);
  const first = journal.rows.find((row) => row.studentId === contact.id);
  const second = journal.rows.find((row) => row.studentId !== contact.id);
  assert.ok(first && second);
  await get(journalRoute, other, 404);
  await write(journalRoute + '/draft', { studentId: first.studentId, points: 11 }, teacher, 400);
  await write(journalRoute + '/draft', { studentId: first.studentId, points: 0 });
  const restored = await login('teacher1', passwords[1]);
  assert.equal((await get(journalRoute, restored)).rows.find((row) => row.studentId === first.studentId).draft, 0);
  assert.equal((await grades()).lessonScores, undefined);
  const publish = (clientId) => write(journalRoute + '/publish', { clientId });
  const publication = await publish('first-publication');
  assert.deepEqual(await publish('first-publication'), publication);
  assert.equal((await grades()).lessonScores[0].points, 0);
  assert.equal((await get(journalRoute, teacher)).rows.find((row) => row.studentId === second.studentId).points, null);

  const score = (action, points) => write(journalRoute + '/score', { studentId: first.studentId, action, points });
  const changed = await score('change', 7);
  const firstDeadline = changed.rows.find((row) => row.studentId === first.studentId).editableUntil;
  assert.equal((await grades()).points, initialPoints + 7);
  await score('delete');
  assert.equal((await grades()).points, initialPoints);
  await score('restore');
  assert.equal((await grades()).points, initialPoints + 7);

  const groupBusy = studentSchedule
    .find((item) => item.title !== lesson.title && !item.cancelled && baseline.lessons.every((slot) =>
      slot.date !== item.date || slot.status === 'cancelled' || slot.start >= item.end || slot.end <= item.start));
  assert.ok(groupBusy);
  const conflict = await write(loc, {
    action: 'move', date: groupBusy.date, start: groupBusy.start, end: groupBusy.end, room: 'Онлайн',
  }, teacher, 409);
  assert.match(conflict.error, /группы/);
  const newDate = '2026-11-30';
  const move = { action: 'move', date: newDate, start: '20:00', end: '21:00', room: 'Онлайн', comment: 'Подключитесь заранее.' };
  const { lesson: moved } = await write(loc, move);
  assert.equal(moved.id, lesson.id);
  assert.equal(moved.originalDate, lesson.date);
  assert.equal(moved.originalStart, lesson.start);
  assert.equal(moved.status, 'moved');
  const next = await get('/api/schedule?week=2026-11-30', student);
  const movedForStudent = next.selectedWeek.lessons.find((item) => item.status === 'moved');
  assert.equal(movedForStudent.date, newDate);
  assert.equal((await get('/api/lessons/' + movedForStudent.id, student)).lesson.status, 'moved');
  assert.ok((await get('/api/teacher/schedule?week=2026-11-30', teacher)).lessons.some((item) => item.id === moved.id));
  assert.ok(!(await get(week, teacher)).lessons.some((item) => item.id === moved.id));
  assert.equal((await grades()).lessonScores[0].date, newDate);
  await write(loc, { action: 'cancel', comment: 'Новое сообщение.' });
  const cancelled = (await get('/api/schedule?month=2026-11', student)).lessons.find((item) => item.id === movedForStudent.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled, true);
  assert.ok((await get('/api/cabinet', student)).notifications.some(({ title }) => title === 'Занятие отменено'));

  await write(journalRoute + '/draft', { studentId: second.studentId, points: 4 });
  const secondPublication = await publish('second-publication');
  const undoRoute = (id) => '/api/teacher/publications/' + id + '/undo';
  await write(undoRoute(publication.publicationId), {}, other, 404);
  const undone = await write(undoRoute(publication.publicationId), {});
  assert.equal(undone.rows.find((row) => row.studentId === first.studentId).draft, 7);
  assert.equal(undone.rows.find((row) => row.studentId === second.studentId).points, 4);
  await write(undoRoute(publication.publicationId), {});
  assert.equal((await grades()).points, initialPoints);
  const republished = await publish('third-publication');
  assert.equal((await get(journalRoute, teacher)).rows.find((row) => row.studentId === first.studentId).editableUntil, firstDeadline);
  db.prepare('UPDATE teacher_journal_scores SET first_published_at = ? WHERE publication_id = ?')
    .run(Date.now() - 86400001, republished.publicationId);
  await write(journalRoute + '/score', { studentId: first.studentId, action: 'delete' }, teacher, 409);
  await write(undoRoute(republished.publicationId), {}, teacher, 409);
  const recent = (await get('/api/teacher/journal', teacher)).recent;
  assert.equal(recent.find(({ id }) => id === republished.publicationId).expiredCount, 1);
  assert.equal(recent.find(({ id }) => id === secondPublication.publicationId).canUndo, true);
  assert.equal((await grades()).points, initialPoints + 7);

  // A publication with an expired and a still-editable score cannot be undone partially.
  const secondUndo = await write(undoRoute(secondPublication.publicationId), {});
  assert.equal(secondUndo.rows.find((row) => row.studentId === second.studentId).draft, 4);
  await write(undoRoute(republished.publicationId), {}, teacher, 409);
  const mixedLesson = baseline.lessons.find((item) => item.id !== lesson.id && item.group === student.profile.group);
  assert.ok(mixedLesson);
  const mixed = '/api/teacher/journal/' + mixedLesson.id;
  await write(mixed + '/draft', { studentId: first.studentId, points: 2 });
  await write(mixed + '/draft', { studentId: second.studentId, points: 3 });
  const mixedPublication = await write(mixed + '/publish', { clientId: 'mixed' });
  db.prepare('UPDATE teacher_journal_scores SET first_published_at = ? WHERE publication_id = ? AND enrollment_id = ?')
    .run(Date.now() - 86400001, mixedPublication.publicationId, first.enrollmentId);
  await write(undoRoute(mixedPublication.publicationId), {}, teacher, 409);
  const mixedScores = (await get(mixed, teacher)).rows;
  assert.equal(mixedScores.find((row) => row.studentId === first.studentId).points, 2);
  assert.equal(mixedScores.find((row) => row.studentId === second.studentId).points, 3);
  await write(mixed + '/score', { studentId: second.studentId, action: 'change', points: 8 });
});
