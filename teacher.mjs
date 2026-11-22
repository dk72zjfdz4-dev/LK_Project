const dayMs = 86400000;
const work = 'Работа на занятии';
const maxPoints = 10;

export function installTeacherWorkflows(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teacher_lesson_changes (
      id TEXT PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES students(id),
      original_date TEXT NOT NULL,
      date TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      room TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('moved','cancelled')),
      comment TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS teacher_lesson_targets (
      change_id TEXT NOT NULL REFERENCES teacher_lesson_changes(id) ON DELETE CASCADE,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id),
      PRIMARY KEY (change_id, lesson_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS teacher_lesson_original ON teacher_lesson_changes(original_date);
    CREATE INDEX IF NOT EXISTS teacher_lesson_date ON teacher_lesson_changes(date);
    CREATE INDEX IF NOT EXISTS teacher_lesson_target ON teacher_lesson_targets(lesson_id);
    CREATE TABLE IF NOT EXISTS teacher_journal_drafts (
      teacher_id INTEGER NOT NULL REFERENCES students(id),
      lesson_id TEXT NOT NULL,
      enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
      points REAL NOT NULL CHECK (points >= 0 AND points <= 10),
      PRIMARY KEY (teacher_id, lesson_id, enrollment_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS teacher_journal_publications (
      id INTEGER PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES students(id),
      lesson_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      undone_at INTEGER,
      UNIQUE (teacher_id, lesson_id, client_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS teacher_journal_scores (
      teacher_id INTEGER NOT NULL REFERENCES students(id),
      lesson_id TEXT NOT NULL,
      enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
      points REAL NOT NULL CHECK (points >= 0 AND points <= 10),
      state TEXT NOT NULL CHECK (state IN ('published','deleted','unpublished')),
      first_published_at INTEGER NOT NULL,
      publication_id INTEGER NOT NULL REFERENCES teacher_journal_publications(id),
      PRIMARY KEY (teacher_id, lesson_id, enrollment_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS teacher_score_enrollment ON teacher_journal_scores(enrollment_id, state);
    CREATE TABLE IF NOT EXISTS teacher_journal_history (
      id INTEGER PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES students(id),
      lesson_id TEXT NOT NULL,
      enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
      publication_id INTEGER NOT NULL REFERENCES teacher_journal_publications(id),
      at INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('publish','change','delete','restore','undo')),
      before REAL,
      after REAL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS teacher_history_lesson ON teacher_journal_history(teacher_id, lesson_id, enrollment_id);
    CREATE INDEX IF NOT EXISTS teacher_history_publication ON teacher_journal_history(publication_id, action);
  `);
}

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * dayMs);
}

function compareSlots(a, b) {
  return a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id);
}

function sameSlot(a, b) {
  return a.group === b.group && a.weekday === b.weekday && a.start_time === b.start_time
    && a.end_time === b.end_time && a.title === b.title && a.room === b.room;
}

export function createTeacherWorkflows(db, { transaction, HttpError, civilDate, weekInMoscow, weekParity, matchesWeek }) {
  const prepare = (sql) => db.prepare(sql);
  const less = `
    SELECT l.*, p.parity AS week_parity, student.student_group AS "group", student.faculty
    FROM lessons l JOIN students student ON student.id = l.student_id
    LEFT JOIN lesson_week_parity p ON p.lesson_id = l.id
    WHERE student.role = 'student'
  `;
  const scheduleRows = prepare(less + ' AND l.weekday = ?');
  const teacherRows = prepare(less + `
    AND l.teacher = (SELECT full_name FROM students WHERE id = ? AND role = 'teacher')
    AND EXISTS (SELECT 1 FROM enrollments e
      WHERE e.teacher_id = ? AND e.subject = l.title AND e.student_id = student.id
      AND e.semester = (SELECT MAX(semester) FROM enrollments WHERE student_id = student.id))
    ORDER BY l.id
  `);
  const enrollmentRows = prepare(`
    SELECT e.id, s.id AS studentId, s.full_name AS name FROM enrollments e
    JOIN students s ON s.id = e.student_id
    WHERE e.teacher_id = ? AND e.subject = ? AND s.student_group = ? AND s.role = 'student'
      AND e.semester = (SELECT MAX(semester) FROM enrollments WHERE student_id = s.id)
    ORDER BY s.full_name, s.id
  `);
  const changeById = prepare('SELECT * FROM teacher_lesson_changes WHERE id = ?');
  const canceledRows = prepare('SELECT lesson_id AS id, change FROM lesson_cancellations WHERE date = ?');
  const changedSlots = prepare(`
    SELECT c.*, t.lesson_id, l.teacher, s.student_group AS "group" FROM teacher_lesson_changes c
    JOIN teacher_lesson_targets t ON t.change_id = c.id JOIN lessons l ON l.id = t.lesson_id
    JOIN students s ON s.id = l.student_id
    WHERE c.original_date = ? OR c.date = ?
  `);
  const studentChanges = prepare(`
    SELECT c.*, t.lesson_id FROM teacher_lesson_changes c
    JOIN teacher_lesson_targets t ON t.change_id = c.id JOIN lessons l ON l.id = t.lesson_id
    WHERE l.student_id = ? AND (c.original_date BETWEEN ? AND ? OR c.date BETWEEN ? AND ?)
  `);
  const changedLessons = prepare(`
    SELECT DISTINCT id FROM teacher_lesson_changes WHERE teacher_id = ? AND date BETWEEN ? AND ?
  `);
  const writeChange = prepare(`
    INSERT INTO teacher_lesson_changes (id, teacher_id, original_date, date, start, end, room, status, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET date = excluded.date, start = excluded.start, end = excluded.end,
      room = excluded.room, status = excluded.status, comment = excluded.comment
  `);
  const writeTarget = prepare('INSERT OR IGNORE INTO teacher_lesson_targets (change_id, lesson_id) VALUES (?, ?)');
  const notify = prepare('INSERT INTO notifications (account_id, title, text, created_at) VALUES (?, ?, ?, ?)');
  const assignedContacts = prepare(`
    WITH groups AS (
      SELECT DISTINCT s.student_group FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.teacher_id = ? AND s.role = 'student' AND s.student_group <> ''
        AND e.semester = (SELECT MAX(semester) FROM enrollments WHERE student_id = s.id)
    )
    SELECT id, id AS partnerId, full_name AS name, role,
      CASE role WHEN 'dean' THEN 'Деканат' ELSE 'Студент' END AS roleLabel,
      student_group AS "group", CASE WHEN role = 'dean' THEN program ELSE '' END AS department
    FROM students
    WHERE role = 'dean' OR (role = 'student' AND student_group IN (SELECT student_group FROM groups))
    ORDER BY full_name, id
  `);
  const drafts = prepare('SELECT enrollment_id, points FROM teacher_journal_drafts WHERE teacher_id = ? AND lesson_id = ?');
  const saveDraft = prepare(`
    INSERT INTO teacher_journal_drafts (teacher_id, lesson_id, enrollment_id, points) VALUES (?, ?, ?, ?)
    ON CONFLICT (teacher_id, lesson_id, enrollment_id) DO UPDATE SET points = excluded.points
  `);
  const removeDraft = prepare('DELETE FROM teacher_journal_drafts WHERE teacher_id = ? AND lesson_id = ? AND enrollment_id = ?');
  const scores = prepare('SELECT * FROM teacher_journal_scores WHERE teacher_id = ? AND lesson_id = ?');
  const writeScore = prepare(`
    INSERT INTO teacher_journal_scores (teacher_id, lesson_id, enrollment_id, points, state, first_published_at, publication_id)
    VALUES (?, ?, ?, ?, 'published', ?, ?)
    ON CONFLICT (teacher_id, lesson_id, enrollment_id) DO UPDATE SET
      points = excluded.points, state = 'published', publication_id = excluded.publication_id
  `);
  const updateScore = prepare(`
    UPDATE teacher_journal_scores SET state = ?, points = ?
    WHERE teacher_id = ? AND lesson_id = ? AND enrollment_id = ?
  `);
  const histories = prepare(`
    SELECT h.enrollment_id, h.at, h.action, h.before, h.after, teacher.full_name AS author
    FROM teacher_journal_history h JOIN students teacher ON teacher.id = h.teacher_id
    WHERE h.teacher_id = ? AND h.lesson_id = ? ORDER BY h.id DESC
  `);
  const writeHistory = prepare(`
    INSERT INTO teacher_journal_history
    (teacher_id, lesson_id, enrollment_id, publication_id, at, action, before, after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const publishedForStudent = prepare(`
    SELECT s.lesson_id, s.points, l.title, COALESCE(c.date, substr(s.lesson_id, instr(s.lesson_id, '-') + 1)) AS date
    FROM teacher_journal_scores s
    JOIN lessons l ON l.id = CAST(substr(s.lesson_id, 1, instr(s.lesson_id, '-') - 1) AS INTEGER)
    LEFT JOIN teacher_lesson_changes c ON c.id = s.lesson_id
    WHERE s.enrollment_id = ? AND s.state = 'published'
    ORDER BY date DESC, s.lesson_id
  `);
  const recent = prepare('SELECT * FROM teacher_journal_publications WHERE teacher_id = ? ORDER BY id DESC LIMIT 60');
  const publicationById = prepare('SELECT * FROM teacher_journal_publications WHERE teacher_id = ? AND id = ?');
  const publishedRows = prepare(`
    SELECT enrollment_id, after FROM teacher_journal_history WHERE publication_id = ? AND action = 'publish'
  `);
  const repeatedPublication = prepare(`
    SELECT id FROM teacher_journal_publications WHERE teacher_id = ? AND lesson_id = ? AND client_id = ?
  `);
  const startPublication = prepare(`
    INSERT INTO teacher_journal_publications (teacher_id, lesson_id, client_id, published_at) VALUES (?, ?, ?, ?)
  `);
  const markUndone = prepare('UPDATE teacher_journal_publications SET undone_at = ? WHERE id = ?');
  const journalSaved = prepare(`
    SELECT lesson_id AS id FROM teacher_journal_drafts WHERE teacher_id = ?
    UNION SELECT lesson_id AS id FROM teacher_journal_scores WHERE teacher_id = ?
  `);

  function mondayFor(week) {
    const monday = dateValue(week);
    if (!monday || monday.getUTCDay() !== 1 || week > '9999-12-26') {
      throw new HttpError(400, 'Укажите дату понедельника в формате ГГГГ-ММ-ДД.');
    }
    return monday;
  }

  function slotsOn(rows, date) {
    const weekday = date.getUTCDay() || 7;
    return rows.filter((row) => row.weekday === weekday && matchesWeek(row, weekParity(date)));
  }

  function bareLesson(row, date) {
    return {
      id: `${row.id}-${date}`, date, start: row.start_time, end: row.end_time,
      title: row.title, group: row.group, faculty: row.faculty, room: row.room, status: 'scheduled',
      originalDate: date, originalStart: row.start_time, originalEnd: row.end_time,
      comment: date >= '2026-11-23' && date <= '2026-11-29' ? row.change ?? '' : '',
    };
  }

  function projectChange(lesson, change) {
    return {
      ...lesson, date: change.date, start: change.start, end: change.end, room: change.room,
      status: change.status, originalDate: change.original_date,
      originalStart: lesson.start, originalEnd: lesson.end, comment: change.comment,
    };
  }

  function lessonForRows(groupRows, date) {
    const base = bareLesson(groupRows[0], date);
    const change = changeById.get(base.id);
    if (change) return projectChange(base, change);
    const cancellations = new Map(canceledRows.all(date).map((row) => [row.id, row.change]));
    if (groupRows.every((row) => cancellations.has(row.id))) {
      return { ...base, status: 'cancelled', comment: cancellations.get(groupRows[0].id) };
    }
    return base;
  }

  function findLesson(teacherId, id, rows = teacherRows.all(teacherId, teacherId)) {
    const match = /^([1-9]\d{0,14})-(\d{4}-\d{2}-\d{2})$/.exec(id);
    const date = match && dateValue(match[2]);
    if (!date) return null;
    const dayRows = slotsOn(rows, date);
    const anchor = dayRows.find((row) => row.id === Number(match[1]));
    if (!anchor) return null;
    const targets = dayRows.filter((row) => sameSlot(row, anchor));
    return anchor === targets[0] ? { lesson: lessonForRows(targets, match[2]), targets } : null;
  }

  function requireLesson(teacherId, id) {
    const owned = findLesson(teacherId, id);
    if (!owned) throw new HttpError(404, 'Занятие преподавателя не найдено.');
    return owned;
  }

  function teacherWeek(teacherId, week = null) {
    const { today, monday } = weekInMoscow();
    const start = week === null ? monday : mondayFor(week);
    const weekStart = civilDate(start);
    const weekEnd = civilDate(addDays(start, 6));
    const rows = teacherRows.all(teacherId, teacherId);
    const lessons = new Map();
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(start, offset);
      const day = civilDate(date);
      const dayRows = slotsOn(rows, date);
      for (const row of dayRows) {
        const targets = dayRows.filter((candidate) => sameSlot(row, candidate));
        if (row === targets[0]) {
          const lesson = lessonForRows(targets, day);
          if (lesson.date >= weekStart && lesson.date <= weekEnd) lessons.set(lesson.id, lesson);
        }
      }
    }
    for (const { id } of changedLessons.all(teacherId, weekStart, weekEnd)) {
      const owned = findLesson(teacherId, id, rows);
      if (owned) lessons.set(id, owned.lesson);
    }
    const data = { today, weekStart, lessons: [...lessons.values()].sort(compareSlots) };
    if (week === null) {
      data.upcomingChanges = changedLessons.all(teacherId, today, '9999-12-31')
        .map(({ id }) => findLesson(teacherId, id, rows)?.lesson).filter(Boolean).sort(compareSlots);
    }
    return data;
  }

  function changedStudentLessons(studentId, from, to, lessons, projectOriginal) {
    const changes = studentChanges.all(studentId, from, to, from, to);
    if (!changes.length) return lessons;
    const map = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    for (const row of changes) {
      const id = `${row.lesson_id}-${row.original_date}`;
      const original = map.get(id) ?? projectOriginal(id);
      if (!original) continue;
      map.delete(id);
      if (row.date >= from && row.date <= to) map.set(id, studentLesson(original, row));
    }
    return [...map.values()].sort(compareSlots);
  }

  function studentLesson(lesson, change) {
    const updated = projectChange(lesson, change);
    const note = updated.status === 'cancelled' ? 'Отменено' : 'Перенесено';
    return { ...updated, cancelled: updated.status === 'cancelled', change: updated.comment ? `${note}. ${updated.comment}` : note };
  }

  function studentLessonDetails(studentId, lesson) {
    if (!lesson) return null;
    const [lessonId, ...date] = lesson.id.split('-');
    const day = date.join('-');
    const change = studentChanges.all(studentId, day, day, day, day)
      .find((row) => row.original_date === day && row.lesson_id === Number(lessonId));
    return change ? studentLesson(lesson, change) : lesson;
  }

  function conflicts(lesson, targets, date, start, end, room) {
    const day = dateValue(date);
    const teacher = targets[0].teacher;
    const cancellations = new Set(canceledRows.all(date).map((row) => row.id));
    const changes = changedSlots.all(date, date).filter((row) => row.id !== lesson.id);
    const changedOriginals = new Set(changes.filter((row) => row.original_date === date).map((row) => row.lesson_id));
    const sourceIds = new Set(targets.map((row) => row.id));
    const base = slotsOn(scheduleRows.all(day.getUTCDay() || 7), day)
      .filter((row) => !cancellations.has(row.id) && !changedOriginals.has(row.id)
        && !(sourceIds.has(row.id) && date === lesson.originalDate))
      .map((row) => ({ ...row, start: row.start_time, end: row.end_time }));
    const moved = changes.filter((row) => row.status === 'moved' && row.date === date);
    for (const slot of [...base, ...moved]) {
      if (slot.start >= end || slot.end <= start) continue;
      if (slot.teacher === teacher) return 'В это время у преподавателя уже есть занятие.';
      if (slot.group === lesson.group) return 'В это время у группы уже есть занятие.';
      if (room && slot.room.trim().toLocaleLowerCase('ru') === room.trim().toLocaleLowerCase('ru')) {
        return 'В это время аудитория уже занята.';
      }
    }
    return '';
  }

  function changeLesson(teacherId, id, body) {
    return transaction(() => {
      const { lesson, targets } = requireLesson(teacherId, id);
      const action = body?.action;
      const comment = body?.comment ?? '';
      if (!['move', 'cancel'].includes(action) || typeof comment !== 'string' || comment.length > 500) {
        throw new HttpError(400, 'Укажите действие и комментарий до 500 символов.');
      }
      const status = action === 'move' ? 'moved' : 'cancelled';
      const date = action === 'move' ? body.date : lesson.date;
      const start = action === 'move' ? body.start : lesson.start;
      const end = action === 'move' ? body.end : lesson.end;
      const roomValue = action === 'move' ? body.room ?? lesson.room : lesson.room;
      if (!dateValue(date) || date > '9999-12-26'
        || typeof start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)
        || typeof end !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end
        || typeof roomValue !== 'string' || !roomValue.trim() || roomValue.length > 100) {
        throw new HttpError(400, 'Укажите действительные дату, время и аудиторию или формат занятия.');
      }
      const room = roomValue.trim();
      if (lesson.status === status && lesson.date === date && lesson.start === start && lesson.end === end
        && lesson.room === room && lesson.comment === comment.trim()) return { lesson };
      if (action === 'move') {
        const conflict = conflicts(lesson, targets, date, start, end, room);
        if (conflict) throw new HttpError(409, conflict);
      }
      writeChange.run(id, teacherId, lesson.originalDate, date, start, end, room, status, comment.trim());
      for (const row of targets) writeTarget.run(id, row.id);
      const title = action === 'move' ? 'Занятие перенесено' : 'Занятие отменено';
      const text = `${lesson.title}, ${lesson.date} в ${lesson.start}.`
        + (action === 'move' ? ` Новый слот: ${date}, ${start}–${end}, ${room}.` : '')
        + (comment.trim() ? ' ' + comment.trim() : '');
      const at = new Date().toISOString();
      for (const studentId of new Set(targets.map((row) => row.student_id))) notify.run(studentId, title, text, at);
      return { lesson: lessonForRows(targets, lesson.originalDate) };
    });
  }

  function journalRows(teacherId, lesson, now) {
    const key = [teacherId, lesson.id];
    const draftMap = new Map(drafts.all(...key).map((row) => [row.enrollment_id, row.points]));
    const scoreMap = new Map(scores.all(...key).map((row) => [row.enrollment_id, row]));
    const history = Map.groupBy(histories.all(...key), (row) => row.enrollment_id);
    return enrollmentRows.all(teacherId, lesson.title, lesson.group).map(({ id, studentId, name }) => {
      const score = scoreMap.get(id);
      return {
        enrollmentId: id, studentId, name, draft: draftMap.get(id) ?? null,
        points: score?.state === 'published' ? score.points : null,
        deleted: score?.state === 'deleted',
        firstPublishedAt: score ? new Date(score.first_published_at).toISOString() : null,
        editableUntil: score ? new Date(score.first_published_at + dayMs).toISOString() : null,
        canEdit: Boolean(score && now < score.first_published_at + dayMs),
        history: (history.get(id) ?? []).map(({ author, at, action, before, after }) => ({
          author, at: new Date(at).toISOString(), action, before, after,
        })),
      };
    });
  }

  function journal(teacherId, id) {
    const { lesson } = requireLesson(teacherId, id);
    return { lesson, work, maxPoints, rows: journalRows(teacherId, lesson, Date.now()) };
  }

  function requirePoints(points) {
    if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > maxPoints) {
      throw new HttpError(400, `Укажите балл от 0 до ${maxPoints}.`);
    }
    return points;
  }

  function requireJournalRow(rows, studentId) {
    const row = rows.find((item) => item.studentId === studentId);
    if (!row) throw new HttpError(404, 'Студент не найден в журнале занятия.');
    return row;
  }

  function requireWindow(row) {
    if (row.editableUntil && !row.canEdit) throw new HttpError(409, '24 часа с первой публикации истекли. Обратитесь в деканат.');
  }

  function draft(teacherId, id, body) {
    return transaction(() => {
      const data = journal(teacherId, id);
      const row = requireJournalRow(data.rows, body?.studentId);
      if (row.points !== null) throw new HttpError(409, 'Измените опубликованный балл через историю оценок.');
      requireWindow(row);
      const key = [teacherId, id, row.enrollmentId];
      if (body.points === null) removeDraft.run(...key);
      else saveDraft.run(...key, requirePoints(body.points));
      return journal(teacherId, id);
    });
  }

  function publish(teacherId, id, body) {
    return transaction(() => {
      const { rows } = journal(teacherId, id);
      const clientId = body?.clientId;
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
        throw new HttpError(400, 'Некорректный идентификатор публикации.');
      }
      const duplicate = repeatedPublication.get(teacherId, id, clientId);
      if (duplicate) return { publicationId: duplicate.id };
      const filled = rows.filter((row) => row.draft !== null);
      if (!filled.length) throw new HttpError(400, 'Заполните хотя бы один балл.');
      for (const row of filled) requireWindow(row);
      const now = Date.now();
      const { lastInsertRowid: publicationId } = startPublication.run(teacherId, id, clientId, now);
      for (const row of filled) {
        const key = [teacherId, id, row.enrollmentId];
        writeScore.run(...key, row.draft, now, publicationId);
        writeHistory.run(...key, publicationId, now, 'publish', null, row.draft);
        removeDraft.run(...key);
      }
      return { publicationId };
    });
  }

  function editScore(teacherId, id, body) {
    return transaction(() => {
      const { rows } = journal(teacherId, id);
      const row = requireJournalRow(rows, body?.studentId);
      const action = body?.action;
      if (!['change', 'delete', 'restore'].includes(action)) throw new HttpError(400, 'Укажите действие с баллом.');
      requireWindow(row);
      const score = scores.all(teacherId, id).find(({ enrollment_id }) => enrollment_id === row.enrollmentId);
      if (!score || score.state === 'unpublished') throw new HttpError(409, 'Балл ещё не опубликован.');
      if (action === 'change' && score.state !== 'published') throw new HttpError(409, 'Сначала восстановите балл.');
      const before = row.points;
      const after = action === 'delete' ? null : action === 'restore' ? score.points : requirePoints(body.points);
      if (before !== after) {
        const key = [teacherId, id, row.enrollmentId];
        updateScore.run(after === null ? 'deleted' : 'published', after ?? score.points, ...key);
        if (action === 'restore') removeDraft.run(...key);
        writeHistory.run(...key, score.publication_id, Date.now(), action, before, after);
      }
      return journal(teacherId, id);
    });
  }

  function publicationRows(teacherId, publication, rows) {
    const original = publishedRows.all(publication.id);
    const scoreMap = new Map(scores.all(teacherId, publication.lesson_id).map((score) => [score.enrollment_id, score]));
    const visible = rows.filter((row) => original.some(({ enrollment_id }) => enrollment_id === row.enrollmentId));
    const affected = visible.filter(({ enrollmentId }) => {
      const score = scoreMap.get(enrollmentId);
      return score?.publication_id === publication.id && score.state !== 'unpublished';
    });
    return { original, affected, visible, scoreMap };
  }

  function undo(teacherId, publicationId) {
    return transaction(() => {
      const publication = publicationById.get(teacherId, publicationId);
      if (!publication) throw new HttpError(404, 'Публикация не найдена.');
      const data = journal(teacherId, publication.lesson_id);
      if (publication.undone_at !== null) return data;
      const { original, affected, scoreMap } = publicationRows(teacherId, publication, data.rows);
      if (original.length !== affected.length) throw new HttpError(409, 'Часть оценок больше не относится к этой публикации.');
      for (const row of affected) requireWindow(row);
      const now = Date.now();
      for (const row of affected) {
        const score = scoreMap.get(row.enrollmentId);
        const key = [teacherId, publication.lesson_id, row.enrollmentId];
        saveDraft.run(...key, score.points);
        updateScore.run('unpublished', score.points, ...key);
        writeHistory.run(...key, publication.id, now, 'undo', row.points, null);
      }
      markUndone.run(now, publication.id);
      return journal(teacherId, publication.lesson_id);
    });
  }

  function journalIndex(teacherId) {
    const { monday } = weekInMoscow();
    const choices = new Map();
    for (let offset = -14; offset <= 14; offset += 7) {
      for (const lesson of teacherWeek(teacherId, civilDate(addDays(monday, offset))).lessons) choices.set(lesson.id, lesson);
    }
    for (const { id } of journalSaved.all(teacherId, teacherId)) {
      const owned = findLesson(teacherId, id);
      if (owned) choices.set(id, owned.lesson);
    }
    const lessons = [...choices.values()].sort(compareSlots).map((lesson) => ({
      ...lesson, draftCount: drafts.all(teacherId, lesson.id).length,
    }));
    const latest = [];
    for (const publication of recent.all(teacherId)) {
      const lesson = choices.get(publication.lesson_id);
      if (!lesson) continue;
      const { original, affected, visible } = publicationRows(teacherId, publication, journalRows(teacherId, lesson, Date.now()));
      const expiredCount = affected.filter((row) => !row.canEdit).length;
      const blockedCount = original.length - affected.length;
      latest.push({
        id: publication.id, lessonId: lesson.id, title: lesson.title, group: lesson.group, date: lesson.date, work, maxPoints,
        count: original.length, expiredCount, blockedCount, canUndo: publication.undone_at === null && !expiredCount && !blockedCount,
        publishedAt: new Date(publication.published_at).toISOString(),
        undoneAt: publication.undone_at === null ? null : new Date(publication.undone_at).toISOString(),
        rows: visible.map((row) => ({ ...row, originalPoints: original.find(({ enrollment_id }) => enrollment_id === row.enrollmentId).after })),
      });
    }
    return { lessons, recent: latest };
  }

  function contacts(teacherId) {
    const contacts = assignedContacts.all(teacherId);
    return { contacts, groups: [...new Set(contacts.map((contact) => contact.group).filter(Boolean))].sort() };
  }

  function projectGrades(rows) {
    return rows.map((row) => {
      const lessonScores = publishedForStudent.all(row.id).map(({ lesson_id, ...score }) => ({ ...score, lessonId: lesson_id, maxPoints }));
      if (!lessonScores.length) return row;
      return {
        ...row, lessonScores,
        points: row.points + lessonScores.reduce((total, score) => total + score.points, 0),
        maxPoints: row.maxPoints + lessonScores.length * maxPoints,
      };
    });
  }

  return { teacherWeek, changeLesson, changedStudentLessons, studentLessonDetails, journalIndex, journal, draft, publish,
    editScore, undo, contacts, projectGrades };
}
