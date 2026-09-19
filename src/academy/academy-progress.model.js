import mongoose from "mongoose";

const AcademyQuizResultSchema = new mongoose.Schema({
  lessonId: { type: String, required: true, trim: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  answeredAt: { type: Date, default: Date.now },
}, { _id: false });

const AcademyProgressSchema = new mongoose.Schema({
  customerId: { type: String, required: true, unique: true, index: true, trim: true },
  completedLessonIds: { type: [String], default: [] },
  lastViewedLessonId: { type: String, default: null },
  quizResults: { type: [AcademyQuizResultSchema], default: [] },
}, {
  timestamps: true,
  versionKey: false,
});

export default mongoose.model("AcademyProgress", AcademyProgressSchema);
