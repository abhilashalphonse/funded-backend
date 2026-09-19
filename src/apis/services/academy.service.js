import AcademyProgress from "../../academy/academy-progress.model.js";

function customerKey(customer) {
  return String(customer?.customerId || customer?.id || customer?.email || "").trim();
}

function serialize(record) {
  if (!record) {
    return {
      completedLessonIds: [],
      lastViewedLessonId: null,
      quizResults: [],
      updatedAt: null,
    };
  }

  return {
    completedLessonIds: [...new Set((record.completedLessonIds || []).map(String))],
    lastViewedLessonId: record.lastViewedLessonId || null,
    quizResults: (record.quizResults || []).map(item => ({
      lessonId: String(item.lessonId),
      score: Number(item.score || 0),
      answeredAt: item.answeredAt || null,
    })),
    updatedAt: record.updatedAt || null,
  };
}

export async function getAcademyProgress(customer) {
  const customerId = customerKey(customer);
  if (!customerId) throw customerError();
  const record = await AcademyProgress.findOne({ customerId }).lean();
  return serialize(record);
}

export async function viewAcademyLesson(customer, lessonId) {
  const customerId = customerKey(customer);
  const normalizedLessonId = normalizeLessonId(lessonId);
  if (!customerId) throw customerError();

  const record = await AcademyProgress.findOneAndUpdate(
    { customerId },
    {
      $set: { lastViewedLessonId: normalizedLessonId },
      $setOnInsert: { completedLessonIds: [], quizResults: [] },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  return serialize(record);
}

export async function completeAcademyLesson(customer, lessonId, { score = null } = {}) {
  const customerId = customerKey(customer);
  const normalizedLessonId = normalizeLessonId(lessonId);
  if (!customerId) throw customerError();

  const numericScore = score == null ? null : Number(score);
  if (numericScore != null && (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100)) {
    const error = new Error("Quiz score must be between 0 and 100.");
    error.status = 400;
    throw error;
  }

  const update = {
    $addToSet: { completedLessonIds: normalizedLessonId },
    $set: { lastViewedLessonId: normalizedLessonId },
    $setOnInsert: { quizResults: [] },
  };

  const record = await AcademyProgress.findOneAndUpdate(
    { customerId },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  if (numericScore != null) {
    const existing = record.quizResults.find(item => item.lessonId === normalizedLessonId);
    if (existing) {
      if (numericScore > Number(existing.score || 0)) existing.score = numericScore;
      existing.answeredAt = new Date();
    } else {
      record.quizResults.push({ lessonId: normalizedLessonId, score: numericScore, answeredAt: new Date() });
    }
    await record.save();
  }

  return serialize(record);
}

function normalizeLessonId(value) {
  const lessonId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(lessonId)) {
    const error = new Error("A valid academy lesson id is required.");
    error.status = 400;
    throw error;
  }
  return lessonId;
}

function customerError() {
  const error = new Error("Customer identity is required for academy progress.");
  error.status = 401;
  return error;
}
