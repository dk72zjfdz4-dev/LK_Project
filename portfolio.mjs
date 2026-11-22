import { crc32 } from 'node:zlib';
import { portfolioPdf, portfolioPrint } from './portfolio-export.mjs';

const maxUpload = 10 * 1024 * 1024;
const categories = new Set([
  'study', 'research', 'projects', 'olympiads', 'volunteering', 'sports', 'creativity', 'internships',
]);

export function migratePortfolio(db) {
  db.exec(`
    CREATE TABLE portfolio_dean_groups (
      dean_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      student_group TEXT NOT NULL CHECK (length(student_group) > 0),
      PRIMARY KEY (dean_id, student_group)
    ) STRICT;
    INSERT INTO portfolio_dean_groups (dean_id, student_group)
      SELECT id, 'МО-24-02' FROM students WHERE login = 'dekanat1' AND role = 'dean';

    CREATE TABLE portfolio_achievements (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      reviewer_id INTEGER REFERENCES students(id),
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      organizer TEXT NOT NULL,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'confirmed', 'clarification', 'rejected')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT,
      deleted_at TEXT,
      CHECK (status = 'draft' OR reviewer_id IS NOT NULL),
      CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX portfolio_achievements_student ON portfolio_achievements(student_id, id);
    CREATE INDEX portfolio_achievements_reviewer ON portfolio_achievements(reviewer_id, id);
    CREATE TABLE portfolio_achievement_files (
      achievement_id INTEGER PRIMARY KEY REFERENCES portfolio_achievements(id),
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png')),
      contents BLOB NOT NULL CHECK (length(contents) BETWEEN 1 AND 10485760)
    ) STRICT;
    CREATE TABLE portfolio_achievement_history (
      id INTEGER PRIMARY KEY,
      achievement_id INTEGER NOT NULL REFERENCES portfolio_achievements(id),
      actor_id INTEGER NOT NULL REFERENCES students(id),
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      reviewer_name TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX portfolio_achievement_events ON portfolio_achievement_history(achievement_id, id);

    CREATE TABLE portfolio_recommendations (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      teacher_id INTEGER NOT NULL REFERENCES students(id),
      goal TEXT NOT NULL,
      context TEXT NOT NULL,
      deadline TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'clarification', 'rejected', 'published')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX portfolio_recommendations_student ON portfolio_recommendations(student_id, id);
    CREATE INDEX portfolio_recommendations_teacher ON portfolio_recommendations(teacher_id, id);
    CREATE TABLE portfolio_recommendation_history (
      id INTEGER PRIMARY KEY,
      recommendation_id INTEGER NOT NULL REFERENCES portfolio_recommendations(id),
      actor_id INTEGER NOT NULL REFERENCES students(id),
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX portfolio_recommendation_events ON portfolio_recommendation_history(recommendation_id, id);
    CREATE TABLE portfolio_recommendation_drafts (
      recommendation_id INTEGER PRIMARY KEY REFERENCES portfolio_recommendations(id),
      text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE portfolio_recommendation_versions (
      id INTEGER PRIMARY KEY,
      recommendation_id INTEGER NOT NULL REFERENCES portfolio_recommendations(id),
      version INTEGER NOT NULL CHECK (version > 0),
      text TEXT NOT NULL,
      author_name TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE (recommendation_id, version)
    ) STRICT;
    CREATE TRIGGER portfolio_versions_immutable_update
      BEFORE UPDATE ON portfolio_recommendation_versions
      BEGIN SELECT RAISE(ABORT, 'Published versions are immutable'); END;
    CREATE TRIGGER portfolio_versions_immutable_delete
      BEFORE DELETE ON portfolio_recommendation_versions
      BEGIN SELECT RAISE(ABORT, 'Published versions are immutable'); END;
    PRAGMA user_version = 7;
  `);
}

export function isPng(contents) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!contents.subarray(0, 8).equals(signature)) return false;
  let hasImageData = false;
  for (let offset = 8; offset + 12 <= contents.length;) {
    const size = contents.readUInt32BE(offset);
    const type = contents.toString('latin1', offset + 4, offset + 8);
    const next = offset + size + 12;
    if (next > contents.length || !/^[a-zA-Z]{4}$/.test(type)
        || crc32(contents.subarray(offset + 4, next - 4)) !== contents.readUInt32BE(next - 4)) return false;
    if (offset === 8) {
      if (type !== 'IHDR' || size !== 13 || !contents.readUInt32BE(offset + 8)
          || !contents.readUInt32BE(offset + 12)) return false;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT' && size > 0) hasImageData = true;
    if (type === 'IEND') return hasImageData && size === 0 && next === contents.length;
    offset = next;
  }
  return false;
}

export function isJpeg(contents) {
  if (contents.length < 4 || contents.readUInt16BE(0) !== 0xffd8
      || contents.readUInt16BE(contents.length - 2) !== 0xffd9) return false;
  let offset = 2;
  let frame = false;
  while (offset + 4 < contents.length && contents[offset] === 0xff) {
    while (contents[offset] === 0xff) offset++;
    const marker = contents[offset++];
    if (offset + 2 > contents.length || marker < 0xc0 || marker === 0xd8 || marker === 0xd9) return false;
    const size = contents.readUInt16BE(offset);
    if (size < 2 || offset + size > contents.length - 2) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 11 || !contents.readUInt16BE(offset + 3) || !contents.readUInt16BE(offset + 5)
          || size !== 8 + 3 * contents[offset + 7]) return false;
      frame = true;
    }
    if (marker === 0xda) {
      const components = contents[offset + 2];
      return frame && components > 0 && size === 6 + 2 * components && offset + size < contents.length - 2;
    }
    offset += size;
  }
  return false;
}

export function createPortfolio(db, { HttpError, bytesBody, isPdf, now, text }) {
  const prepare = (sql) => db.prepare(sql);
  const enrollmentScope = `EXISTS (
    SELECT 1 FROM enrollments AS e WHERE e.student_id = student.id AND e.teacher_id = @viewerId
  )`;
  const deanScope = `EXISTS (
    SELECT 1 FROM portfolio_dean_groups AS scope
    WHERE scope.dean_id = @viewerId AND scope.student_group = student.student_group
  )`;
  const achievementAccess = `a.deleted_at IS NULL AND student.role = 'student' AND (
    (@viewerRole = 'student' AND a.student_id = @viewerId) OR (
      a.status <> 'draft' AND a.reviewer_id = @viewerId AND (
        (@viewerRole = 'teacher' AND ${enrollmentScope}) OR (@viewerRole = 'dean' AND ${deanScope})
      )
    )
  )`;
  const recommendationAccess = `student.role = 'student' AND (
    (@viewerRole = 'student' AND r.student_id = @viewerId) OR
    (@viewerRole = 'teacher' AND r.teacher_id = @viewerId AND ${enrollmentScope})
  )`;
  const achievementSelect = `
    SELECT a.id, student.id AS studentId, student.full_name AS studentName,
      a.title, a.category, a.organizer, a.date, a.description, a.status,
      reviewer.id AS reviewerId, reviewer.full_name AS reviewerName,
      f.filename, f.media_type AS mediaType, length(f.contents) AS size,
      a.created_at AS createdAt, a.updated_at AS updatedAt, a.confirmed_at AS confirmedAt
    FROM portfolio_achievements AS a
    JOIN students AS student ON student.id = a.student_id
    LEFT JOIN students AS reviewer ON reviewer.id = a.reviewer_id
    LEFT JOIN portfolio_achievement_files AS f ON f.achievement_id = a.id
    WHERE ${achievementAccess}
  `;
  const recommendationSelect = `
    SELECT r.id, student.id AS studentId, student.full_name AS studentName,
      teacher.id AS teacherId, teacher.full_name AS teacherName, r.goal, r.context, r.deadline, r.status,
      r.created_at AS createdAt, r.updated_at AS updatedAt
    FROM portfolio_recommendations AS r
    JOIN students AS student ON student.id = r.student_id
    JOIN students AS teacher ON teacher.id = r.teacher_id
    WHERE ${recommendationAccess}
  `;
  const listAchievements = prepare(`${achievementSelect} ORDER BY a.id DESC`);
  const achievementById = prepare(`${achievementSelect} AND a.id = @id`);
  const listRecommendations = prepare(`${recommendationSelect} ORDER BY r.id DESC`);
  const recommendationById = prepare(`${recommendationSelect} AND r.id = @id`);
  const reviewers = prepare(`
    SELECT staff.id, staff.full_name AS name, staff.role FROM students AS staff
    JOIN students AS student ON student.id = @studentId AND student.role = 'student'
    WHERE (staff.role = 'teacher' AND EXISTS (
      SELECT 1 FROM enrollments AS e WHERE e.student_id = student.id AND e.teacher_id = staff.id
    )) OR (staff.role = 'dean' AND EXISTS (
      SELECT 1 FROM portfolio_dean_groups AS scope
      WHERE scope.dean_id = staff.id AND scope.student_group = student.student_group
    ))
    ORDER BY staff.role DESC, staff.full_name, staff.id
  `);
  const studentForExport = prepare(`
    SELECT full_name AS studentName, faculty, program, student_group AS "group"
    FROM students WHERE id = ? AND role = 'student'
  `);
  const achievementHistory = prepare(`
    SELECT id, action, status, note, actor_name AS actorName, actor_role AS actorRole,
      reviewer_name AS reviewerName, created_at AS createdAt
    FROM portfolio_achievement_history WHERE achievement_id = ? ORDER BY id
  `);
  const recommendationHistory = prepare(`
    SELECT id, action, status, note, actor_name AS actorName, actor_role AS actorRole, created_at AS createdAt
    FROM portfolio_recommendation_history WHERE recommendation_id = ? ORDER BY id
  `);
  const versionSelect = `
    SELECT id, version, text, author_name AS authorName, published_at AS publishedAt
    FROM portfolio_recommendation_versions WHERE recommendation_id = ? ORDER BY version DESC
  `;
  const publishedVersions = prepare(versionSelect);
  const latestVersion = prepare(`${versionSelect} LIMIT 1`);
  const findDraft = prepare('SELECT text FROM portfolio_recommendation_drafts WHERE recommendation_id = ?');
  const findFile = prepare(`
    SELECT f.filename, f.media_type, f.contents FROM portfolio_achievement_files AS f
    JOIN portfolio_achievements AS a ON a.id = f.achievement_id
    JOIN students AS student ON student.id = a.student_id
    WHERE a.id = @id AND ${achievementAccess}
  `);
  const upsertFile = prepare(`
    INSERT INTO portfolio_achievement_files (achievement_id, filename, media_type, contents) VALUES (?, ?, ?, ?)
    ON CONFLICT(achievement_id) DO UPDATE SET filename = excluded.filename,
      media_type = excluded.media_type, contents = excluded.contents
    WHERE filename <> excluded.filename OR media_type <> excluded.media_type OR contents <> excluded.contents
  `);
  const removeFile = prepare('DELETE FROM portfolio_achievement_files WHERE achievement_id = ?');
  const insertAchievement = prepare(`
    INSERT INTO portfolio_achievements (student_id, title, category, organizer, date, description, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `);
  const editAchievement = prepare(`
    UPDATE portfolio_achievements
    SET title = @title, category = @category, organizer = @organizer, date = @date, description = @description
    WHERE id = @id AND (title <> @title OR category <> @category OR organizer <> @organizer
      OR date <> @date OR description <> @description)
  `);
  const setAchievementStatus = prepare(`
    UPDATE portfolio_achievements SET status = ?, reviewer_id = ?, updated_at = ?, confirmed_at = ? WHERE id = ?
  `);
  const archiveAchievement = prepare('UPDATE portfolio_achievements SET deleted_at = ?, updated_at = ? WHERE id = ?');
  const addAchievementEvent = prepare(`
    INSERT INTO portfolio_achievement_history
      (achievement_id, actor_id, actor_name, actor_role, reviewer_name, action, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRecommendation = prepare(`
    INSERT INTO portfolio_recommendations (student_id, teacher_id, goal, context, deadline, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const editRecommendation = prepare(`
    UPDATE portfolio_recommendations SET goal = ?, context = ?, deadline = ? WHERE id = ?
  `);
  const setRecommendationStatus = prepare('UPDATE portfolio_recommendations SET status = ?, updated_at = ? WHERE id = ?');
  const addRecommendationEvent = prepare(`
    INSERT INTO portfolio_recommendation_history
      (recommendation_id, actor_id, actor_name, actor_role, action, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertDraft = prepare(`
    INSERT INTO portfolio_recommendation_drafts (recommendation_id, text) VALUES (?, ?)
    ON CONFLICT(recommendation_id) DO UPDATE SET text = excluded.text
  `);
  const removeDraft = prepare('DELETE FROM portfolio_recommendation_drafts WHERE recommendation_id = ?');
  const insertVersion = prepare(`
    INSERT INTO portfolio_recommendation_versions (recommendation_id, text, author_name, published_at, version)
    VALUES (@id, @text, @author, @date, (
      SELECT COALESCE(MAX(version), 0) + 1 FROM portfolio_recommendation_versions WHERE recommendation_id = @id
    ))
  `);

  function scope(viewer) {
    return { viewerId: viewer.id, viewerRole: viewer.role };
  }

  function found(value, message) {
    if (!value) throw new HttpError(404, message);
    return value;
  }

  function achievement(viewer, id) {
    return found(achievementById.get({ ...scope(viewer), id }), 'Достижение не найдено.');
  }

  function recommendation(viewer, id) {
    return found(recommendationById.get({ ...scope(viewer), id }), 'Запрос рекомендации не найден.');
  }

  function state(value, allowed) {
    if (!allowed.includes(value)) throw new HttpError(409, 'Действие недоступно на этом этапе.');
  }

  function civilDate(value, message) {
    if (typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = new Date(`${value}T00:00:00Z`);
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
    }
    throw new HttpError(400, message);
  }

  function achievementFields({ title, category, organizer, date, description }) {
    if (!categories.has(category)) throw new HttpError(400, 'Выберите категорию достижения.');
    return {
      title: text(title, 'Укажите название достижения', 150), category,
      organizer: text(organizer, 'Укажите организатора', 150),
      date: civilDate(date, 'Укажите действительную дату достижения.'),
      description: text(description, 'Проверьте описание', 1500, false),
    };
  }

  function recommendationFields({ goal, context, deadline }) {
    return {
      goal: text(goal, 'Укажите цель рекомендации', 150),
      context: text(context, 'Проверьте контекст', 1500, false),
      deadline: civilDate(deadline, 'Укажите действительную дату предоставления рекомендации.'),
    };
  }

  function overview(viewer) {
    const access = scope(viewer);
    const availableReviewers = viewer.role === 'student' ? reviewers.all({ studentId: viewer.id }) : [];
    return {
      achievements: listAchievements.all(access).map(({ filename, mediaType, size, ...item }) => ({
        ...item, attachment: filename === null ? null : { filename, mediaType, size },
        history: achievementHistory.all(item.id),
      })),
      recommendations: listRecommendations.all(access).map((item) => ({
        ...item, history: recommendationHistory.all(item.id), versions: publishedVersions.all(item.id),
        ...(viewer.role === 'teacher' ? { draft: findDraft.get(item.id)?.text ?? '' } : {}),
      })),
      reviewers: availableReviewers,
      teachers: availableReviewers.filter(({ role }) => role === 'teacher'),
    };
  }

  function achievementEvent(viewer, item, status, action, note, timestamp) {
    setAchievementStatus.run(status, item.reviewerId, timestamp, status === 'confirmed' ? timestamp : null, item.id);
    addAchievementEvent.run(
      item.id, viewer.id, viewer.full_name, viewer.role, item.reviewerName, action, status, note, timestamp,
    );
  }

  function createAchievement(viewer, _id, body) {
    const fields = achievementFields(body);
    const timestamp = now();
    const { lastInsertRowid: id } = insertAchievement.run(
      viewer.id, fields.title, fields.category, fields.organizer, fields.date, fields.description, timestamp, timestamp,
    );
    addAchievementEvent.run(id, viewer.id, viewer.full_name, viewer.role, null, 'created', 'draft', '', timestamp);
    return { id };
  }

  function updateAchievement(viewer, id, body) {
    const item = achievement(viewer, id);
    if (editAchievement.run({ ...achievementFields(body), id }).changes) {
      achievementEvent(viewer, item, 'draft', 'edited', '', now());
    }
    return { id };
  }

  function deleteAchievement(viewer, id) {
    const item = achievement(viewer, id);
    state(item.status, ['draft']);
    const timestamp = now();
    removeFile.run(id);
    archiveAchievement.run(timestamp, timestamp, id);
  }

  function submitAchievement(viewer, id, { reviewerId }) {
    const item = achievement(viewer, id);
    state(item.status, ['draft', 'clarification']);
    const reviewer = found(reviewers.all({ studentId: viewer.id }).find(({ id }) => id === reviewerId),
      'Выбранный проверяющий недоступен.');
    achievementEvent(viewer, { ...item, reviewerId: reviewer.id, reviewerName: reviewer.name }, 'pending', 'submitted', '', now());
  }

  function reviewAchievement(viewer, id, { status, note }) {
    if (viewer.role === 'student') throw new HttpError(403, 'Действие недоступно для вашей роли.');
    const item = achievement(viewer, id);
    state(item.status, ['pending']);
    if (!['confirmed', 'clarification', 'rejected'].includes(status)) throw new HttpError(400, 'Выберите решение.');
    achievementEvent(viewer, item, status, 'reviewed', text(note, 'Введите комментарий', 1500, status !== 'confirmed'), now());
  }

  async function upload(request, viewer, id) {
    achievement(viewer, id);
    const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    const formats = new Map([
      ['application/pdf', [/\.pdf$/i, isPdf]], ['image/jpeg', [/\.jpe?g$/i, isJpeg]], ['image/png', [/\.png$/i, isPng]],
    ]);
    const format = formats.get(mediaType);
    if (!format) throw new HttpError(415, 'Прикрепите файл PDF, JPG или PNG.');
    const [extension, matches] = format;
    let filename;
    try {
      filename = decodeURIComponent(request.headers['x-filename'] ?? '');
    } catch {
      throw new HttpError(400, 'Не удалось прочитать имя файла.');
    }
    // eslint-disable-next-line no-control-regex -- Reject control characters in uploaded filenames.
    if (filename.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(filename) || !extension.test(filename.trim())) {
      throw new HttpError(400, 'Проверьте имя и расширение файла.');
    }
    const contents = await bytesBody(request, maxUpload);
    if (!matches(contents)) throw new HttpError(415, 'Содержимое файла не соответствует заявленному формату.');
    return { filename: filename.trim(), mediaType, contents };
  }

  function attachFile(viewer, id, { filename, mediaType, contents }) {
    const item = achievement(viewer, id);
    if (upsertFile.run(id, filename, mediaType, contents).changes) {
      achievementEvent(viewer, item, 'draft', 'file_attached', '', now());
    }
  }

  function detachFile(viewer, id) {
    const item = achievement(viewer, id);
    if (removeFile.run(id).changes) achievementEvent(viewer, item, 'draft', 'file_removed', '', now());
  }

  function downloadFile(viewer, id) {
    return found(findFile.get({ ...scope(viewer), id }), 'Файл не найден.');
  }

  function recommendationEvent(viewer, id, status, action, note, timestamp) {
    setRecommendationStatus.run(status, timestamp, id);
    addRecommendationEvent.run(id, viewer.id, viewer.full_name, viewer.role, action, status, note, timestamp);
  }

  function createRecommendation(viewer, _id, body) {
    const { teacherId } = body;
    found(reviewers.all({ studentId: viewer.id }).find(({ id, role }) => id === teacherId && role === 'teacher'),
      'Выбранный преподаватель недоступен.');
    const { goal, context, deadline } = recommendationFields(body);
    const timestamp = now();
    const { lastInsertRowid: id } = insertRecommendation.run(viewer.id, teacherId, goal, context, deadline, timestamp, timestamp);
    addRecommendationEvent.run(id, viewer.id, viewer.full_name, viewer.role, 'requested', 'pending', '', timestamp);
    return { id };
  }

  function resubmitRecommendation(viewer, id, body) {
    const item = recommendation(viewer, id);
    state(item.status, ['clarification']);
    const { goal, context, deadline } = recommendationFields(body);
    editRecommendation.run(goal, context, deadline, id);
    recommendationEvent(viewer, id, 'pending', 'resubmitted', '', now());
  }

  function reviewRecommendation(viewer, id, { status, note }) {
    const item = recommendation(viewer, id);
    state(item.status, ['pending', 'accepted']);
    if (!['accepted', 'clarification', 'rejected'].includes(status)) throw new HttpError(400, 'Выберите решение.');
    if (item.status === status) throw new HttpError(409, 'Решение уже сохранено.');
    recommendationEvent(viewer, id, status, 'reviewed', text(note, 'Введите комментарий', 1500, status !== 'accepted'), now());
  }

  function saveRecommendationDraft(viewer, id, { text: draft }) {
    const item = recommendation(viewer, id);
    state(item.status, ['accepted', 'published']);
    upsertDraft.run(id, text(draft, 'Введите текст рекомендации', 2500));
  }

  function publishRecommendation(viewer, id) {
    const item = recommendation(viewer, id);
    state(item.status, ['accepted', 'published']);
    const draft = findDraft.get(id);
    if (!draft) throw new HttpError(409, 'Сначала сохраните черновик рекомендации.');
    const date = now();
    insertVersion.run({ id, text: draft.text, author: viewer.full_name, date });
    removeDraft.run(id);
    recommendationEvent(viewer, id, 'published', 'published', '', date);
  }

  function selection(query, key) {
    const parameters = query.getAll(key);
    if (parameters.length !== 1) throw new HttpError(400, 'Укажите состав портфолио.');
    if (!parameters[0]) return [];
    const values = parameters[0].split(',');
    if (values.length > 100 || values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      throw new HttpError(400, 'Проверьте список записей для портфолио.');
    }
    return [...new Set(values.map(Number))];
  }

  function exportData(viewer, query) {
    const achievementIds = selection(query, 'achievementIds');
    const recommendationIds = selection(query, 'recommendationIds');
    if (!achievementIds.length && !recommendationIds.length) throw new HttpError(400, 'Выберите записи для портфолио.');
    const requestedStudent = query.getAll('studentId');
    const studentId = requestedStudent.length === 0 && viewer.role === 'student' ? viewer.id : Number(requestedStudent[0]);
    if (requestedStudent.length > 1 || (requestedStudent.length === 1 && !/^[1-9]\d*$/.test(requestedStudent[0]))
        || !Number.isSafeInteger(studentId) || (viewer.role === 'student' && viewer.id !== studentId)) {
      throw new HttpError(404, 'Портфолио недоступно.');
    }
    const achievements = achievementIds.map((id) => {
      const item = achievement(viewer, id);
      if (item.studentId !== studentId || (viewer.role !== 'student' && item.status !== 'confirmed')) {
        throw new HttpError(404, 'Достижение недоступно для выгрузки.');
      }
      const { title, category, organizer, date, description, status, reviewerName, confirmedAt } = item;
      return { id, title, category, organizer, date, description, status, reviewerName, confirmedAt };
    });
    const recommendations = recommendationIds.map((id) => {
      const item = recommendation(viewer, id);
      const published = latestVersion.get(id);
      if (item.studentId !== studentId || !published) throw new HttpError(404, 'Рекомендация недоступна для выгрузки.');
      const { version, text, authorName, publishedAt } = published;
      return { id, goal: item.goal, version, text, authorName, publishedAt };
    });
    return { ...found(studentForExport.get(studentId), 'Портфолио недоступно.'), achievements, recommendations };
  }

  async function exportPdf(viewer, _id, query) {
    return { filename: 'portfolio.pdf', media_type: 'application/pdf', contents: await portfolioPdf(exportData(viewer, query)) };
  }

  function exportPrint(viewer, _id, query) {
    return portfolioPrint(exportData(viewer, query));
  }

  return [
    { method: 'GET', path: /^\/api\/portfolio$/, action: overview },
    { method: 'GET', path: /^\/api\/portfolio\/pdf$/, query: true, download: true, action: exportPdf },
    { method: 'GET', path: /^\/api\/portfolio\/print$/, query: true, print: true, action: exportPrint },
    { method: 'POST', path: /^\/api\/portfolio\/achievements$/, role: 'student', action: createAchievement },
    { method: 'POST', path: /^\/api\/portfolio\/achievements\/([^/]+)$/, role: 'student', action: updateAchievement },
    { method: 'POST', path: /^\/api\/portfolio\/achievements\/([^/]+)\/delete$/, role: 'student', action: deleteAchievement },
    { method: 'POST', path: /^\/api\/portfolio\/achievements\/([^/]+)\/submit$/, role: 'student', action: submitAchievement },
    { method: 'POST', path: /^\/api\/portfolio\/achievements\/([^/]+)\/review$/, action: reviewAchievement },
    { method: 'POST', path: /^\/api\/portfolio\/achievements\/([^/]+)\/file$/, role: 'student', parse: upload, action: attachFile },
    { method: 'POST', path: /^\/api\/portfolio\/achievements\/([^/]+)\/remove-file$/, role: 'student', action: detachFile },
    { method: 'GET', path: /^\/api\/portfolio\/achievements\/([^/]+)\/file$/, download: true, action: downloadFile },
    { method: 'POST', path: /^\/api\/portfolio\/recommendations$/, role: 'student', action: createRecommendation },
    { method: 'POST', path: /^\/api\/portfolio\/recommendations\/([^/]+)\/resubmit$/, role: 'student', action: resubmitRecommendation },
    { method: 'POST', path: /^\/api\/portfolio\/recommendations\/([^/]+)\/review$/, role: 'teacher', action: reviewRecommendation },
    { method: 'POST', path: /^\/api\/portfolio\/recommendations\/([^/]+)\/draft$/, role: 'teacher', action: saveRecommendationDraft },
    { method: 'POST', path: /^\/api\/portfolio\/recommendations\/([^/]+)\/publish$/, role: 'teacher', action: publishRecommendation },
  ];
}
