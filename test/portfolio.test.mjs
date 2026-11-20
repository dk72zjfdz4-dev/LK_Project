import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('private portfolio workflows, reviewer scope and exports', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cabinet-portfolio-'));
  const passwords = Object.fromEntries(['student1', 'student2', 'teacher1', 'dean1'].map((login) => [login, randomBytes(16).toString('hex')]));
  const dbPath = join(directory, 'test.sqlite');
  let server;
  let origin;
  async function stop() {
    if (server?.exitCode === null && server.signalCode === null) {
      const ended = once(server, 'exit');
      server.kill();
      await ended;
    }
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], {
      env: {
        HOST: '127.0.0.1', PORT: '0', DB_PATH: dbPath, DEMO_PASSWORD_1: passwords.student1,
        DEMO_PASSWORD_2: passwords.student2, DEMO_PASSWORD_TEACHER: passwords.teacher1, DEMO_PASSWORD_DEAN: passwords.dean1,
      },
    });
    origin = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      server.stderr.on('data', (chunk) => { stderr += chunk; });
      server.stdout.on('data', (chunk) => {
        stdout += chunk;
        const address = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) resolve(address);
      });
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Test server exited (${code}): ${stderr}`)));
    });
  }
  await start();

  async function request(path, cookie, body, contentType) {
    const headers = cookie ? { Cookie: cookie } : {};
    if (body === undefined) return fetch(origin + '/api' + path, { headers });
    headers.Origin = origin;
    headers['Content-Type'] = contentType ?? 'application/json';
    if (contentType) headers['X-Filename'] = 'proof.png';
    return fetch(origin + '/api' + path, { method: 'POST', headers, body: contentType ? body : JSON.stringify(body) });
  }
  async function json(path, cookie, body, status = 200) {
    const response = await request(path, cookie, body);
    const data = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function login(login) {
    const response = await request('/login', null, { login, password: passwords[login] });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const student = await login('student1');
  const other = await login('student2');
  const teacher = await login('teacher1');
  const dean = await login('dean1');
  const base = '/portfolio';
  const snapshot = (cookie) => json(base, cookie);
  const scope = await snapshot(student);
  const teacherId = scope.teachers[0].id;
  const deanId = scope.reviewers.find(({ role }) => role === 'dean').id;
  assert.ok(!(await snapshot(other)).reviewers.some(({ id }) => id === deanId));
  assert.equal((await request(base, null)).status, 401);

  const input = {
    title: 'Учебный проект «Обсерватория»', category: 'projects', date: '2026-10-20',
    description: 'Макет демонстрационной обсерватории.', organizer: 'Кружок астрономии',
  };
  await json(base + '/achievements', student, { ...input, category: 'unknown' }, 400);
  await json(base + '/achievements', student, input);
  const item = (await snapshot(student)).achievements.find(({ title }) => title === input.title);
  const achievement = base + '/achievements/' + item.id;
  assert.equal(item.status, 'draft');
  assert.ok(!(await snapshot(teacher)).achievements.some(({ id }) => id === item.id));
  assert.equal((await request(achievement + '/file', student, Buffer.from('not PNG'), 'image/png')).status, 415);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await request(achievement + '/file', student, image, 'image/png')).status, 200);
  assert.equal((await request(achievement + '/file', other)).status, 404);
  assert.equal((await request(achievement + '/file', teacher)).status, 404);
  assert.equal((await request(achievement + '/file', student, Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png')).status, 413);
  await json(achievement + '/submit', student, { reviewerId: teacherId });
  assert.ok((await snapshot(teacher)).achievements.some(({ id, status }) => id === item.id && status === 'pending'));
  const proof = await request(achievement + '/file', teacher);
  assert.equal(proof.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await proof.arrayBuffer()), image);
  assert.equal((await request(achievement + '/file', dean)).status, 404);
  await json(achievement + '/review', teacher, { status: 'clarification', note: 'Уточните вклад в проект.' });
  await json(achievement, student, { ...input, description: 'Подготовила макет и описание.' });
  await json(achievement + '/submit', student, { reviewerId: teacherId });
  await json(achievement + '/review', teacher, { status: 'confirmed', note: 'Описание уточнено.' });
  await json(achievement, student, { ...input, description: 'Обновлённое описание проекта.' });
  assert.equal((await snapshot(student)).achievements.find(({ id }) => id === item.id).status, 'draft');
  assert.equal((await request(achievement + '/file', teacher)).status, 404);
  await json(achievement + '/submit', student, { reviewerId: deanId });
  await json(achievement + '/review', dean, { status: 'confirmed', note: 'Подтверждено в демо.' });
  const achievementSelection = `?studentId=${item.studentId}&achievementIds=${item.id}&recommendationIds=`;
  assert.equal((await request(base + '/pdf' + achievementSelection, dean)).status, 200);
  assert.equal((await request(base + '/pdf' + achievementSelection, teacher)).status, 404);

  const recommendation = { teacherId, goal: 'Отбор в учебную лабораторию', context: 'Демонстрационная заявка', deadline: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) };
  await json(base + '/recommendations', student, recommendation);
  const first = (await snapshot(student)).recommendations.find(({ goal }) => goal === recommendation.goal);
  const rec = base + '/recommendations/' + first.id;
  await json(rec + '/review', teacher, { status: 'accepted', note: 'Принято.' });
  await json(rec + '/draft', teacher, { text: 'Приватный черновик преподавателя.' });
  assert.doesNotMatch(JSON.stringify(await snapshot(student)), /Приватный черновик/);
  assert.doesNotMatch(JSON.stringify(await snapshot(other)), /учебную лабораторию|Приватный черновик/);
  const ids = `?achievementIds=${item.id}&recommendationIds=${first.id}`;
  assert.equal((await request(base + '/pdf' + ids, student)).status, 404);
  await json(rec + '/draft', teacher, { text: 'Подготовила демонстрационный макет.' });
  await json(rec + '/publish', teacher, {});
  await json(rec + '/draft', teacher, { text: 'Обновлённая рекомендация преподавателя.' });
  assert.doesNotMatch(JSON.stringify(await snapshot(student)), /Обновлённая рекомендация/);
  await json(rec + '/publish', teacher, {});
  const published = (await snapshot(student)).recommendations.find(({ id }) => id === first.id);
  assert.equal(published.versions.length, 2);
  assert.equal(published.versions[0].text, 'Обновлённая рекомендация преподавателя.');
  assert.equal(published.versions[1].text, 'Подготовила демонстрационный макет.');
  const recommendationSelection = `?studentId=${item.studentId}&achievementIds=&recommendationIds=${first.id}`;
  assert.equal((await request(base + '/pdf' + recommendationSelection, teacher)).status, 200);
  assert.equal((await request(base + '/pdf' + recommendationSelection, dean)).status, 404);
  await json(base + '/recommendations', student, { ...recommendation, goal: 'Второй демонстрационный запрос' });
  const second = (await snapshot(student)).recommendations.find(({ id }) => id !== first.id);
  await json(base + '/recommendations/' + second.id + '/review', teacher, { status: 'rejected', note: 'Нет необходимых сведений.' });

  const print = await request(base + '/print' + ids, student);
  assert.equal(print.status, 200);
  assert.equal(print.headers.get('cache-control'), 'no-store');
  const html = await print.text();
  assert.match(html, /Конкурсный прототип. Демонстрационные данные/);
  assert.match(html, /Подтверждено/);
  assert.match(html, /Обновлённая рекомендация преподавателя/);
  assert.doesNotMatch(html, /Приватный черновик|<nav|<button/);
  const pdf = await request(base + '/pdf' + ids, student);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(Buffer.from(await pdf.arrayBuffer()).toString('latin1'), /MediaBox \[0 0 595\.28 841\.89\]/);
  assert.equal((await request(base + '/pdf' + ids, other)).status, 404);

  await stop();
  await start();
  const saved = await snapshot(student);
  assert.equal(saved.achievements.find(({ id }) => id === item.id).status, 'confirmed');
  assert.match(JSON.stringify(saved), /Уточните вклад в проект|Уточните вклад/);
  assert.match(JSON.stringify(saved), /Обновлённая рекомендация/);
});
