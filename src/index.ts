export { runAudit, buildResult, VERSION } from './audit.js';
export { renderMarkdown, renderJson } from './report.js';
export { overallScore, verdictFor, prioritize } from './score.js';
export { parseRobots, isAllowed, rulesFor, pathMatches } from './robots.js';
export { parseSitemap, pickExtraPages } from './sitemap.js';
export { politeFetch, TOOL_UA, GPTBOT_UA } from './fetcher.js';
export type { AuditResult, DimensionResult, Evidence, Recommendation } from './types.js';
export type { AuditContext, PageData, SitemapEntry } from './context.js';
