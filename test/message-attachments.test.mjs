import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('message attachments respect dialogue scope, retries and deletion', { timeout: 25000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cabinet-attachments-'));
  const accounts = { student1: '1', student2: '2', teacher1: 'TEACHER' };
  const passwords = new Map();
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', DB_PATH: join(directory, 'test.sqlite') };
  for (const [login, key] of Object.entries(accounts)) {
    passwords.set(login, randomBytes(20).toString('base64url'));
    env['DEMO_PASSWORD_' + key] = passwords.get(login);
  }
  const server = spawn(process.execPath, ['server.mjs'], { env });
  const stopped = once(server, 'close');
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error('Server exited with code ' + code + ': ' + stderr)));
    server.stderr.on('data', (chunk) => { stderr += chunk; });
    server.stdout.on('data', (chunk) => {
      stdout += chunk;
      const address = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) resolve(address);
    });
  });

  async function call(route, cookie, status, body) {
    const headers = cookie ? { Cookie: cookie } : {};
    const multipart = body instanceof FormData;
    if (body !== undefined) {
      headers.Origin = origin;
      if (!multipart) headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(origin + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: multipart || body === undefined ? body : JSON.stringify(body),
    });
    assert.equal(response.status, status, route);
    return response;
  }
  async function login(name) {
    const response = await call('/login', null, 200, { login: name, password: passwords.get(name) });
    await response.text();
    return response.headers.get('set-cookie').split(';')[0];
  }
  const [student, other, teacher] = await Promise.all(Object.keys(accounts).map(login));
  const { dialogues } = await (await call('/cabinet', student, 200)).json();
  const thread = '/dialogues/' + dialogues.find(({ partnerRole }) => partnerRole === 'teacher').id;
  const wrongThread = '/dialogues/' + dialogues.find(({ partnerRole }) => partnerRole === 'dean').id;
  const docx = await readFile(new URL('./fixtures/work.docx', import.meta.url));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const clientId = randomUUID();
  const filename = 'Разбор задания.docx';
  function form(heading, message, files = [[docx, filename, word], [png, 'Схема.png', 'image/png']]) {
    const payload = new FormData();
    payload.set('clientId', heading);
    if (message !== undefined) payload.set('text', message);
    for (const [bytes, name, type] of files) payload.append('files', new Blob([bytes], { type }), name);
    return payload;
  }
  const write = (cookie, status, body) => call(thread + '/messages', cookie, status, body);
  const [first, repeat] = await Promise.all([write(teacher, 200, form(clientId)), write(teacher, 200, form(clientId))]);
  const { message } = await first.json();
  assert.deepEqual((await repeat.json()).message, message);
  assert.equal(message.text, '');
  assert.equal(message.attachments.length, 2);
  const [document, image] = message.attachments;
  assert.equal(document.filename, filename);
  assert.equal(document.mediaType, word);
  assert.equal(document.size, docx.length);
  assert.equal(document.previewUrl, undefined);
  assert.equal(image.previewUrl, image.url + '?preview=1');
  const recipient = await (await call(thread, student, 200)).json();
  assert.deepEqual(recipient.messages.find(({ id }) => id === message.id).attachments, message.attachments);
  assert.equal(recipient.messages.filter(({ id }) => id === message.id).length, 1);
  const latest = await (await call('/cabinet', student, 200)).json();
  assert.equal(latest.dialogues.find(({ id }) => '/dialogues/' + id === thread).lastText, filename);

  const downloadPath = document.url.slice(4);
  const download = await call(downloadPath, student, 200);
  assert.equal(download.headers.get('content-type'), word);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(download.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), docx);
  const preview = await call(image.previewUrl.slice(4), student, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const docPreview = await call(downloadPath + '?preview=1', student, 200);
  assert.match(docPreview.headers.get('content-disposition'), /^attachment;/);
  await docPreview.arrayBuffer();
  await call(downloadPath, other, 404);
  await call(downloadPath, null, 401);
  await call(wrongThread + '/attachments/' + document.id, student, 404);
  await write(other, 404, form(randomUUID()));
  await write(teacher, 409, form(clientId, 'Другой текст'));
  await write(teacher, 409, form(clientId, undefined, [[docx, 'Другое имя.docx', word], [png, 'Схема.png', 'image/png']]));
  await write(teacher, 415, form(randomUUID(), 'Файл', [[docx, 'image.png', 'image/png']]));
  await write(teacher, 413, form(randomUUID(), 'Файл', [[Buffer.alloc(10 * 1024 * 1024 + 1), 'big.docx', word]]));
  await write(teacher, 400, { attachmentFiles: [{ filename: 'fake.pdf' }] });

  const withText = await (await write(teacher, 200, form(randomUUID(), 'Материалы занятия', [[docx, filename, word]]))).json();
  assert.equal(withText.message.text, 'Материалы занятия');
  assert.equal(withText.message.attachments.length, 1);
  const remove = thread + '/messages/' + message.id + '/delete';
  await call(remove, teacher, 200, { scope: 'self' });
  await call(downloadPath, teacher, 404);
  await (await call(downloadPath, student, 200)).arrayBuffer();
  await call(remove, teacher, 200, { scope: 'all' });
  await call(downloadPath, student, 404);
  await write(teacher, 410, form(clientId));
});
