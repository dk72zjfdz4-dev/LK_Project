export function installDeanWorkflows(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dean_announcements (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES students(id),
      client_id TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      audience TEXT NOT NULL CHECK (audience IN ('students', 'teachers', 'all')),
      created_at TEXT NOT NULL,
      recipient_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (author_id, client_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS certificate_versions (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      version INTEGER NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      contents BLOB NOT NULL CHECK (length(contents) BETWEEN 1 AND 10485760),
      upload_author_id INTEGER NOT NULL REFERENCES students(id),
      upload_client_id TEXT,
      UNIQUE (request_id, version),
      UNIQUE (request_id, upload_author_id, upload_client_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS certificate_states (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      file_id INTEGER REFERENCES certificate_versions(id),
      details TEXT NOT NULL DEFAULT '',
      managed INTEGER NOT NULL DEFAULT 0 CHECK (managed IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS certificate_deliveries (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      file_id INTEGER NOT NULL REFERENCES certificate_versions(id),
      author_id INTEGER NOT NULL REFERENCES students(id),
      client_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('message', 'notification')),
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      message_id INTEGER UNIQUE REFERENCES messages(id),
      notification_id INTEGER UNIQUE REFERENCES notifications(id),
      CHECK ((channel = 'message' AND message_id IS NOT NULL AND notification_id IS NULL)
        OR (channel = 'notification' AND notification_id IS NOT NULL AND message_id IS NULL)),
      UNIQUE (request_id, author_id, client_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS certificate_active_delivery
      ON certificate_deliveries(request_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS certificate_request_deliveries ON certificate_deliveries(request_id, id);
    CREATE TABLE IF NOT EXISTS certificate_events (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      file_id INTEGER NOT NULL REFERENCES certificate_versions(id),
      author_id INTEGER NOT NULL REFERENCES students(id),
      action TEXT NOT NULL CHECK (action IN ('upload', 'remove', 'send', 'revoke')),
      created_at TEXT NOT NULL,
      channel TEXT CHECK (channel IN ('message', 'notification')),
      delivery_id INTEGER REFERENCES certificate_deliveries(id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS certificate_request_events ON certificate_events(request_id, id);
  `);
}

export function createDeanWorkflows(db, { HttpError, text, now, openDialogue, sendMessage, createNotice, createHistory }) {
  const prepare = (sql) => db.prepare(sql);
  const announcements = prepare(`
    SELECT a.id, a.title, a.text, a.audience, a.created_at AS createdAt,
      a.recipient_count AS recipientCount, author.full_name AS author
    FROM dean_announcements a JOIN students author ON author.id = a.author_id ORDER BY a.id DESC
  `);
  const announcementByKey = prepare(`
    SELECT a.id, a.title, a.text, a.audience, a.created_at AS createdAt,
      a.recipient_count AS recipientCount, author.full_name AS author
    FROM dean_announcements a JOIN students author ON author.id = a.author_id
    WHERE a.author_id = ? AND a.client_id = ?
  `);
  const createAnnouncement = prepare(`
    INSERT INTO dean_announcements (author_id, client_id, title, text, audience, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const notifyAudience = prepare(`
    INSERT INTO notifications (account_id, title, text, created_at)
    SELECT id, ?, ?, ? FROM students
    WHERE directory_only = 0 AND ((? = 'all' AND role IN ('student', 'teacher'))
      OR (? = 'students' AND role = 'student') OR (? = 'teachers' AND role = 'teacher'))
  `);
  const countRecipients = prepare('UPDATE dean_announcements SET recipient_count = ? WHERE id = ?');
  const requestById = prepare('SELECT id, student_id, status, type FROM requests WHERE id = ?');
  const stateById = prepare('SELECT file_id, details, managed FROM certificate_states WHERE request_id = ?');
  const rememberDetails = prepare('INSERT INTO certificate_states (request_id, details) VALUES (?, ?)');
  const manageRequest = prepare(`
    INSERT INTO certificate_states (request_id, managed) VALUES (?, 1)
    ON CONFLICT (request_id) DO UPDATE SET managed = 1
  `);
  const setRequestStatus = prepare('UPDATE requests SET status = ? WHERE id = ?');
  const currentFile = prepare(`
    SELECT f.id, f.filename, f.media_type, f.version, length(f.contents) AS size
    FROM certificate_states s JOIN certificate_versions f ON f.id = s.file_id WHERE s.request_id = ?
  `);
  const equalCurrentFile = prepare(`
    SELECT 1 FROM certificate_states s JOIN certificate_versions f ON f.id = s.file_id
    WHERE s.request_id = ? AND f.filename = ? AND f.media_type = ? AND f.contents = ?
  `);
  const rememberedUpload = prepare(`
    SELECT id, filename, version, length(contents) AS size, (filename = ? AND media_type = ? AND contents = ?) AS same
    FROM certificate_versions WHERE request_id = ? AND upload_author_id = ? AND upload_client_id = ?
  `);
  const storeFile = prepare(`
    INSERT INTO certificate_versions (request_id, version, filename, media_type, contents, upload_author_id, upload_client_id)
    VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM certificate_versions WHERE request_id = ?), ?, ?, ?, ?, ?)
  `);
  const rememberCurrentUpload = prepare('UPDATE certificate_versions SET upload_client_id = ? WHERE id = ? AND upload_client_id IS NULL AND upload_author_id = ?');
  const selectFile = prepare('UPDATE certificate_states SET file_id = ? WHERE request_id = ?');
  const preview = prepare(`
    SELECT f.filename, f.media_type, f.contents
    FROM certificate_states s JOIN certificate_versions f ON f.id = s.file_id
    WHERE s.request_id = ? AND f.id = ?
  `);
  const deliveryFields = `
    SELECT d.id, d.request_id AS requestId, d.channel, d.comment, d.file_id AS fileId,
      d.created_at AS createdAt, d.revoked_at AS revokedAt, d.notification_id AS notificationId,
      f.filename, f.version, length(f.contents) AS size, author.full_name AS author
    FROM certificate_deliveries d
    JOIN certificate_versions f ON f.id = d.file_id
    JOIN students author ON author.id = d.author_id
  `;
  const latestDelivery = prepare(deliveryFields + ' WHERE d.request_id = ? ORDER BY d.id DESC LIMIT 1');
  const deliveryWithKey = prepare(deliveryFields + ' WHERE d.request_id = ? AND d.author_id = ? AND d.client_id = ?');
  const deliveryById = prepare(deliveryFields + ' WHERE d.request_id = ? AND d.id = ?');
  const messageDelivery = prepare(deliveryFields + ' WHERE d.message_id = ?');
  const notificationDelivery = prepare(deliveryFields + ' WHERE d.notification_id = ?');
  const newDelivery = prepare(`
    INSERT INTO certificate_deliveries (request_id, file_id, author_id, client_id, channel, comment, created_at, message_id, notification_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const revokeDelivery = prepare('UPDATE certificate_deliveries SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
  const revokeNotice = prepare("UPDATE notifications SET title = 'Справка отозвана' WHERE id = ?");
  const revokedMessage = prepare("UPDATE messages SET text = 'Справка отозвана' WHERE id = (SELECT message_id FROM certificate_deliveries WHERE id = ?)");
  const download = prepare(`
    SELECT f.filename, f.media_type, f.contents
    FROM certificate_deliveries d JOIN certificate_versions f ON f.id = d.file_id
    JOIN requests r ON r.id = d.request_id
    WHERE d.request_id = ? AND d.id = ? AND d.revoked_at IS NULL
      AND (r.student_id = ? OR ? = 'dean')
  `);
  const writeEvent = prepare(`
    INSERT INTO certificate_events (request_id, file_id, author_id, action, created_at, channel, delivery_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const history = prepare(`
    SELECT e.action, e.created_at AS createdAt, e.channel, e.delivery_id AS deliveryId,
      f.filename, f.version, author.full_name AS author
    FROM certificate_events e JOIN certificate_versions f ON f.id = e.file_id
    JOIN students author ON author.id = e.author_id
    WHERE e.request_id = ? ORDER BY e.id DESC
  `);

  function ensure(resource, message) {
    if (!resource) throw new HttpError(404, message);
    return resource;
  }

  function clientKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      throw new HttpError(400, 'Повторите операцию с действительным идентификатором.');
    }
    return value;
  }

  function publish(viewer, _id, body) {
    const key = clientKey(body.clientId);
    const { audience } = body;
    if (!['students', 'teachers', 'all'].includes(audience)) throw new HttpError(400, 'Выберите аудиторию объявления.');
    const title = text(body.title, 'Введите тему объявления', 160);
    const bodyText = text(body.text, 'Текст объявления', 4000, false);
    const previous = announcementByKey.get(viewer.id, key);
    if (previous) {
      if (previous.title !== title || previous.text !== bodyText || previous.audience !== audience) {
        throw new HttpError(409, 'Этот идентификатор уже сохранён для другого объявления.');
      }
      return { announcement: previous };
    }
    const at = now();
    const { lastInsertRowid: id } = createAnnouncement.run(viewer.id, key, title, bodyText, audience, at);
    countRecipients.run(notifyAudience.run(title, bodyText, at, audience, audience, audience).changes, id);
    return { announcement: announcementByKey.get(viewer.id, key) };
  }

  function request(id) {
    return ensure(requestById.get(id), 'Заявка не найдена.');
  }

  function stagedRequest(id) {
    const row = request(id);
    if (row.status !== 'processing') throw new HttpError(409, 'Сначала возьмите запрос в работу.');
    if (latestDelivery.get(id)?.revokedAt === null) throw new HttpError(409, 'Сначала отзовите отправленную справку.');
    return row;
  }

  function fileView(id, file) {
    return file && {
      id: file.id, filename: file.filename, size: file.size, version: file.version,
      downloadUrl: `/api/requests/${id}/file/${file.id}`,
    };
  }

  function deliveryView(delivery) {
    if (!delivery) return undefined;
    const { id, requestId, channel, filename, size, author, createdAt, revokedAt, version } = delivery;
    return {
      id, requestId, channel, filename, size, author, createdAt, revokedAt, version,
      status: revokedAt === null ? 'sent' : 'revoked',
      ...(revokedAt === null && { downloadUrl: `/api/requests/${requestId}/deliveries/${id}/file` }),
    };
  }

  function requestView(row, role) {
    const state = stateById.get(row.id);
    if (!state) return row;
    const file = role === 'dean' && currentFile.get(row.id);
    const delivery = deliveryView(latestDelivery.get(row.id));
    const status = delivery?.status === 'sent' ? 'sent' : state.file_id !== null ? 'ready_to_send' : row.status;
    return {
      ...row, status, details: state.details,
      ...(delivery && { delivery }),
      ...(role === 'dean' && { certificateFile: fileView(row.id, file), certificateHistory: history.all(row.id) }),
    };
  }

  function take(_viewer, id) {
    const row = request(id);
    if (row.status === 'processing') {
      manageRequest.run(id);
      return;
    }
    if (row.status !== 'submitted') throw new HttpError(409, 'Запрос уже закрыт.');
    const at = now();
    manageRequest.run(id);
    setRequestStatus.run('processing', id);
    createHistory.run(id, 'processing', '', at);
    createNotice.run(row.student_id, 'Запрос на справку взят в работу', row.type, at);
  }

  function upload(viewer, id, payload) {
    const { filename, mediaType, contents } = payload;
    const clientId = payload.clientId === undefined ? null : clientKey(payload.clientId);
    if (clientId !== null) {
      const prior = rememberedUpload.get(filename, mediaType, contents, id, viewer.id, clientId);
      if (prior) {
        if (!prior.same) throw new HttpError(409, 'Идентификатор уже использован для другого файла.');
        const current = currentFile.get(id);
        return { certificateFile: fileView(id, current?.id === prior.id ? current : undefined) };
      }
    }
    stagedRequest(id);
    if (equalCurrentFile.get(id, filename, mediaType, contents)) {
      const current = currentFile.get(id);
      if (clientId === null || rememberCurrentUpload.run(clientId, current.id, viewer.id).changes) {
        return { certificateFile: fileView(id, current) };
      }
    }
    manageRequest.run(id);
    const { lastInsertRowid: fileId } = storeFile.run(id, id, filename, mediaType, contents, viewer.id, clientId);
    selectFile.run(fileId, id);
    writeEvent.run(id, fileId, viewer.id, 'upload', now(), null, null);
    return { certificateFile: fileView(id, currentFile.get(id)) };
  }

  function remove(viewer, id, { fileId }) {
    stagedRequest(id);
    if (!Number.isSafeInteger(fileId) || fileId < 1) throw new HttpError(400, 'Выберите файл для удаления.');
    const file = currentFile.get(id);
    if (!file) return;
    if (file.id !== fileId) throw new HttpError(409, 'Файл уже заменён. Обновите карточку запроса.');
    selectFile.run(null, id);
    writeEvent.run(id, fileId, viewer.id, 'remove', now(), null, null);
  }

  function send(viewer, id, body) {
    const key = clientKey(body.clientId);
    const { fileId, channel } = body;
    if (!['message', 'notification'].includes(channel)) throw new HttpError(400, 'Выберите способ доставки.');
    const comment = channel === 'message' ? text(body.comment, 'Комментарий', 500, false) : '';
    const previous = deliveryWithKey.get(id, viewer.id, key);
    if (previous) {
      if (previous.fileId !== fileId || previous.channel !== channel || previous.comment !== comment) {
        throw new HttpError(409, 'Этот идентификатор уже использован для другой отправки.');
      }
      return { delivery: deliveryView(previous) };
    }
    const row = stagedRequest(id);
    const file = currentFile.get(id);
    if (!file || file.id !== fileId) throw new HttpError(409, 'Файл изменился. Проверьте перед отправкой.');
    const at = now();
    let messageId = null;
    let notificationId = null;
    if (channel === 'message') {
      const { dialogueId } = openDialogue(viewer, row.student_id);
      messageId = sendMessage.get(dialogueId, viewer.id, comment || 'Справка готова', at, null).id;
    } else {
      notificationId = createNotice.run(row.student_id, 'Справка готова', row.type, at).lastInsertRowid;
    }
    const { lastInsertRowid: deliveryId } = newDelivery.run(id, fileId, viewer.id, key, channel, comment, at, messageId, notificationId);
    writeEvent.run(id, fileId, viewer.id, 'send', at, channel, deliveryId);
    return { delivery: deliveryView(deliveryById.get(id, deliveryId)) };
  }

  function revoke(viewer, id, { deliveryId }) {
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) throw new HttpError(400, 'Выберите отправку для отзыва.');
    const delivery = ensure(deliveryById.get(id, deliveryId), 'Отправка не найдена.');
    if (delivery.revokedAt !== null) return { delivery: deliveryView(delivery) };
    const at = now();
    revokeDelivery.run(at, deliveryId);
    if (delivery.notificationId !== null) revokeNotice.run(delivery.notificationId);
    else revokedMessage.run(deliveryId);
    writeEvent.run(id, delivery.fileId, viewer.id, 'revoke', at, delivery.channel, deliveryId);
    return { delivery: deliveryView(deliveryById.get(id, deliveryId)) };
  }

  return {
    list: () => ({ announcements: announcements.all() }), publish, take, upload, remove, send, revoke,
    requestView, isManaged: (id) => Boolean(stateById.get(id)?.managed),
    hasFile: (id) => Boolean(currentFile.get(id)),
    saveDetails: (id, details) => { if (details) rememberDetails.run(id, details); },
    messageDelivery: (id) => deliveryView(messageDelivery.get(id)),
    notificationDelivery: (id) => deliveryView(notificationDelivery.get(id)),
    preview: (_viewer, id, _query, fileId) => {
      const file = ensure(preview.get(id, fileId), 'Файл справки не найден.');
      return { ...file, inline: file.media_type === 'application/pdf', sameOrigin: true };
    },
    download: (viewer, id, _query, deliveryId) => ensure(download.get(id, deliveryId, viewer.id, viewer.role), 'Справка недоступна.'),
    validateUpload: (_viewer, id) => request(id),
  };
}
