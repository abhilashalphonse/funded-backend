import KnowledgeBaseArticle from "./knowledgeBase.model.js";
import { DEFAULT_KNOWLEDGE_BASE } from "./defaultKnowledgeBase.js";

const CATEGORY_EXPANSION = {
  CHALLENGE: ["CHALLENGE", "RISK", "PHASE", "FREE_TRIAL", "PROHIBITED_STRATEGIES"],
  ACG_TRADER: ["ACG_TRADER", "ACCOUNT"],
  PAYMENT: ["PAYMENT", "REFUND"],
  PAYOUT: ["PAYOUT"],
  ACCOUNT: ["ACCOUNT"],
  GENERAL: [],
};

function normalizedTokens(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 3),
  )];
}

export function scoreKnowledgeArticle(article, query, conversationCategory = "GENERAL") {
  const queryText = String(query || "").toLowerCase();
  const queryTokens = normalizedTokens(query);
  const title = String(article.title || "").toLowerCase();
  const summary = String(article.summary || "").toLowerCase();
  const content = String(article.content || "").toLowerCase();
  const keywords = (article.keywords || []).map(keyword => String(keyword).toLowerCase());
  const expandedCategories = CATEGORY_EXPANSION[conversationCategory] || [];

  let score = 0;

  if (expandedCategories.includes(article.category)) score += 5;
  if (article.category === conversationCategory) score += 3;

  for (const keyword of keywords) {
    if (keyword && queryText.includes(keyword)) score += keyword.includes(" ") ? 6 : 4;
  }

  for (const token of queryTokens) {
    if (title.includes(token)) score += 3;
    if (summary.includes(token)) score += 2;
    if (keywords.some(keyword => keyword.includes(token))) score += 2;
    if (content.includes(token)) score += 0.5;
  }

  return score;
}

export async function ensureDefaultKnowledgeBase() {
  const now = new Date();

  for (const article of DEFAULT_KNOWLEDGE_BASE) {
    await KnowledgeBaseArticle.updateOne(
      { slug: article.slug },
      {
        $set: {
          ...article,
          approved: true,
          source: "SYSTEM",
          version: 1,
          approvedAt: now,
          lastReviewedAt: now,
        },
      },
      { upsert: true },
    );
  }
}

export async function retrieveApprovedKnowledge(query, conversationCategory = "GENERAL", limit = 4) {
  const articles = await KnowledgeBaseArticle.find({ approved: true }).lean();

  return articles
    .map(article => ({
      ...article,
      relevanceScore: scoreKnowledgeArticle(article, query, conversationCategory),
    }))
    .filter(article => article.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, Math.max(1, Math.min(Number(limit) || 4, 6)))
    .map(article => ({
      slug: article.slug,
      title: article.title,
      category: article.category,
      summary: article.summary,
      content: article.content,
      version: article.version,
    }));
}
