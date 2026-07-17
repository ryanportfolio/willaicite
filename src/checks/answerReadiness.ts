import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractHeadings, extractJsonLd, extractVisibleText, firstWords, jsonLdTypes, mainContentHtml, countTag, wordCount } from '../html.js';

const QUESTION_START = /^(who|what|why|how|when|where|which|can|does|do|is|are|should|will)\b/i;
const ANSWER_VERB = /\b(is|are|means|refers to|helps|enables|provides|allows|lets)\b/i;

/**
 * Answer-readiness: can an engine lift a direct answer from the top of the
 * page? Heuristics: definitional statement in the first ~200 tokens, question
 * headings, FAQ section, lists/tables, single clear H1.
 */
export function checkAnswerReadiness(ctx: AuditContext): DimensionResult {
  const dim = 'Answer-readiness';
  const html = ctx.target?.html ?? null;
  if (html === null) {
    return {
      key: 'answerReadiness',
      name: dim,
      weight: 3,
      score: null,
      evidence: [{ status: 'unverified', message: 'could not verify — page HTML unavailable' }],
      recommendations: [],
    };
  }

  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  let score = 0;

  const mainHtml = mainContentHtml(html);
  const mainText = extractVisibleText(mainHtml);

  // A page with essentially no extractable text (SPA shell, sign-in screen)
  // scores 0 here, but the useful advice is to fix renderability or audit the
  // actual content page — not to bolt an FAQ onto an empty shell.
  if (wordCount(mainText) < 15) {
    return {
      key: 'answerReadiness',
      name: dim,
      weight: 3,
      score: 0,
      evidence: [
        { status: 'fail', message: `no extractable main content to assess (${wordCount(mainText)} words) — engines that retrieve this page find nothing to answer with` },
        { status: 'info', message: 'content-level checks scored the URL you gave; if the content lives elsewhere (e.g. /about or a docs page), audit that page directly' },
      ],
      recommendations: [
        {
          dimension: dim,
          action: 'Get real text into this page first (see Renderability), or run the audit against the page that actually carries your content',
          why: 'Answer-readiness heuristics (definitional opening, question headings, FAQ) are meaningless on a page with no extractable text — fixing those here would decorate an empty shell.',
          impact: 3,
          effort: 1,
        },
      ],
    };
  }

  const opening = firstWords(mainText, 200);

  // 1. Direct answer statement in the first ~200 tokens (0-30)
  const sentences = opening.split(/(?<=[.!?])\s+/);
  const answerSentence = sentences.find((s) => {
    if (s.trim().endsWith('?')) return false; // a question is not an answer
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length < 4 || words.length > 45) return false;
    const m = s.match(ANSWER_VERB);
    if (!m || m.index === undefined) return false;
    // require an actual subject before the verb (not sentence-initial "Is ...?")
    const before = s.slice(0, m.index).trim();
    return before.split(/\s+/).filter(Boolean).length >= 1;
  });
  if (answerSentence) {
    score += 30;
    evidence.push({ status: 'pass', message: `direct answer statement in the first 200 tokens: "${answerSentence.slice(0, 120)}"` });
  } else {
    evidence.push({ status: 'fail', message: 'no direct definitional/answer statement ("X is/are/means/helps …") found in the first ~200 tokens' });
    recommendations.push({
      dimension: dim,
      action: 'Open the page with a 1-2 sentence direct answer to the query the page targets ("X is …")',
      why: 'Answer engines synthesize from retrieved chunks; a self-contained definitional statement near the top is the chunk most likely to be quoted verbatim. Pages that bury the answer force the engine to synthesize from a competitor that did not.',
      impact: 3,
      effort: 1,
    });
  }

  // 2. Single clear H1 (0-15)
  const headings = extractHeadings(html);
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 1) {
    score += 15;
    evidence.push({ status: 'pass', message: `single clear H1: "${h1s[0].text.slice(0, 80)}"` });
  } else if (h1s.length === 0) {
    evidence.push({ status: 'fail', message: 'no H1 heading found' });
    recommendations.push({
      dimension: dim,
      action: 'Add one H1 that states the page topic',
      why: 'The H1 is the strongest single signal of what the page answers; retrieval rankers and chunkers both key on it.',
      impact: 2,
      effort: 1,
    });
  } else {
    score += 5;
    evidence.push({ status: 'warn', message: `${h1s.length} H1 headings found — topic signal is diluted` });
  }

  // 3. Question-formatted headings (0-25)
  const subHeadings = headings.filter((h) => h.level >= 2);
  const questionHeadings = subHeadings.filter((h) => QUESTION_START.test(h.text) || h.text.trim().endsWith('?'));
  if (questionHeadings.length >= 3) {
    score += 25;
    evidence.push({ status: 'pass', message: `${questionHeadings.length} question-formatted headings (e.g. "${questionHeadings[0].text.slice(0, 70)}")` });
  } else if (questionHeadings.length >= 1) {
    score += 15;
    evidence.push({ status: 'pass', message: `${questionHeadings.length} question-formatted heading(s) (e.g. "${questionHeadings[0].text.slice(0, 70)}")` });
  } else {
    evidence.push({ status: 'fail', message: `0 of ${subHeadings.length} subheadings are question-formatted` });
    recommendations.push({
      dimension: dim,
      action: 'Rephrase key H2/H3 headings as the questions users actually ask ("How does X work?")',
      why: 'AI engines match retrieved chunks against conversational queries; a heading that mirrors the question makes the following section the obvious answer chunk.',
      impact: 2,
      effort: 1,
    });
  }

  // 4. FAQ section (0-15)
  const faqHeading = headings.find((h) => /\bfaq\b|frequently asked/i.test(h.text));
  const faqSchema = jsonLdTypes(extractJsonLd(html).nodes).includes('faqpage');
  if (faqHeading || faqSchema) {
    score += 15;
    evidence.push({
      status: 'pass',
      message: faqHeading ? `FAQ section found (heading: "${faqHeading.text.slice(0, 60)}")` : 'FAQPage schema found',
    });
  } else {
    evidence.push({ status: 'warn', message: 'no FAQ section detected' });
    recommendations.push({
      dimension: dim,
      action: 'Add a short FAQ section answering the 3-5 most common questions on this topic',
      why: 'Each Q+A pair is a pre-packaged retrieval chunk aligned to a real query — the exact unit answer engines quote.',
      impact: 2,
      effort: 2,
    });
  }

  // 5. Lists / tables for enumerable content (0-15)
  const listCount = countTag(mainHtml, 'ul') + countTag(mainHtml, 'ol');
  const tableCount = countTag(mainHtml, 'table');
  if (listCount >= 1) {
    score += 10;
    evidence.push({ status: 'pass', message: `${listCount} list(s) in main content` });
  } else {
    evidence.push({ status: 'warn', message: 'no lists in main content' });
  }
  if (tableCount >= 1) {
    score += 5;
    evidence.push({ status: 'pass', message: `${tableCount} table(s) in main content` });
  } else {
    evidence.push({ status: 'info', message: 'no tables in main content' });
  }
  if (listCount === 0 && tableCount === 0) {
    recommendations.push({
      dimension: dim,
      action: 'Convert enumerable content (steps, comparisons, feature sets) into lists or tables',
      why: 'Structured enumerations survive chunking intact and map directly onto the bulleted formats answer engines prefer to emit.',
      impact: 1,
      effort: 1,
    });
  }

  evidence.push({ status: 'info', message: 'limitation: answer detection is a lexical heuristic (subject + is/are/means/helps near the top), not semantic understanding' });

  return {
    key: 'answerReadiness',
    name: dim,
    weight: 3,
    score: Math.max(0, Math.min(100, Math.round(score))),
    evidence,
    recommendations,
  };
}
