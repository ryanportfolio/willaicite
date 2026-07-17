/**
 * The roster of AI crawler tokens willaicite audits. Single source of truth:
 * the crawler-access check scores against this list, and the landing site's
 * /crawlers registry page renders it, so the two can never disagree.
 *
 * Retrieval-class bots fetch pages to answer live queries or fill a search
 * index; blocking one means that engine can never retrieve or cite the page.
 * Training-class tokens only control model-training data collection (two of
 * them, Google-Extended and Applebot-Extended, are pure opt-out tokens with no
 * crawler behind them); blocking those is a mainstream content policy with a
 * much smaller citation cost, so it is penalized far more lightly.
 *
 * `robotsIgnored`: the operator documents that this fetcher generally ignores
 * robots.txt (user-initiated), so a Disallow records intent without stopping
 * retrieval; it is scored as a light advisory, never as a hard block.
 * `caveat`: appended to blocked-evidence so the stake line stays factual.
 */
export interface AiBot {
  token: string;
  engine: string;
  role: 'retrieval' | 'training';
  robotsIgnored?: boolean;
  caveat?: string;
}

export const AI_BOTS: AiBot[] = [
  { token: 'OAI-SearchBot', engine: 'ChatGPT Search index', role: 'retrieval' },
  { token: 'ChatGPT-User', engine: 'ChatGPT live browsing', role: 'retrieval' },
  { token: 'Claude-SearchBot', engine: 'Claude search index', role: 'retrieval' },
  { token: 'Claude-User', engine: 'Claude live browsing', role: 'retrieval' },
  { token: 'PerplexityBot', engine: 'Perplexity index', role: 'retrieval' },
  {
    token: 'Perplexity-User',
    engine: 'Perplexity live fetch (sends real referrals)',
    role: 'retrieval',
    robotsIgnored: true,
    caveat: 'Perplexity documents that user-initiated fetches generally ignore robots.txt, so this rule records intent but does not stop retrieval',
  },
  { token: 'Bingbot', engine: 'Bing index (feeds Copilot and, residually, ChatGPT answers)', role: 'retrieval' },
  { token: 'Amazonbot', engine: 'Alexa / Rufus answers', role: 'retrieval' },
  { token: 'DuckAssistBot', engine: 'DuckDuckGo AI answers', role: 'retrieval' },
  { token: 'Applebot', engine: 'Siri / Spotlight / Apple Intelligence retrieval', role: 'retrieval' },
  { token: 'MistralAI-User', engine: 'Le Chat live fetch', role: 'retrieval' },
  { token: 'GPTBot', engine: 'OpenAI model training', role: 'training' },
  { token: 'ClaudeBot', engine: 'Anthropic model training', role: 'training' },
  { token: 'CCBot', engine: 'Common Crawl (feeds many training sets)', role: 'training' },
  { token: 'meta-externalagent', engine: 'Meta AI training', role: 'training' },
  {
    token: 'Google-Extended',
    engine: 'Gemini training + grounding opt-out token (no crawler)',
    role: 'training',
    caveat: 'this token also gates Gemini grounding: blocking it stops Gemini from pulling and citing this content at answer time, not just from training on it',
  },
  { token: 'Applebot-Extended', engine: 'Apple Intelligence training opt-out token (no crawler)', role: 'training' },
];
