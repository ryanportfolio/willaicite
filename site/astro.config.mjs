import { defineConfig } from 'astro/config';

export default defineConfig({
  // Static output (default). Landing page for willaicite; audit app lives at /app.
  site: 'https://willaicite.com',
  vite: {
    // /crawlers imports the audit engine's AI_BOTS roster (../src/aiBots.ts)
    // so the registry page and the scoring can never disagree.
    server: { fs: { allow: ['..'] } },
  },
});
