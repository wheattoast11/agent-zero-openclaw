#!/usr/bin/env npx tsx
/**
 * Moltbook Engagement Tool — Reusable CLI for all Moltbook interactions.
 *
 * Commands:
 *   scan              Fetch feed + check our posts for new comments
 *   comment <file>    Post comments/replies from a JSON file
 *   post <file>       Create a new post from a JSON file
 *
 * JSON format for comments:
 *   [{ "postId": "...", "content": "...", "parentId?": "..." }]
 *
 * JSON format for post:
 *   { "title": "...", "content": "...", "submolt?": "general" }
 *
 * Options:
 *   --dry-run         Preview without posting
 *   --our-posts       Comma-separated post IDs to check for replies (scan mode)
 *
 * Usage:
 *   npx tsx scripts/moltbook-engage.ts scan
 *   npx tsx scripts/moltbook-engage.ts scan --our-posts=102ec46e-...,8843f79f-...
 *   npx tsx scripts/moltbook-engage.ts comment targets.json
 *   npx tsx scripts/moltbook-engage.ts comment targets.json --dry-run
 *   npx tsx scripts/moltbook-engage.ts post announcement.json
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { readFileSync } from 'fs';

const API = 'https://www.moltbook.com/api/v1';
const PROXY = 'https://www.moltyverse.live/api/moltbook';
const DRY_RUN = process.argv.includes('--dry-run');
const OUR_AGENT = 'zero-terminals';

function token(): string {
  const t = process.env.MOLTBOOK_API_TOKEN;
  if (!t) { console.error('Set MOLTBOOK_API_TOKEN'); process.exit(1); }
  return t;
}

function headers(t: string) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${t}`,
    'User-Agent': 'AgentZero/0.2.0',
  };
}

async function safeFetch(url: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(url, opts);
  const raw = await res.text();
  const clean = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  if (!res.ok) throw new Error(`${res.status}: ${clean.slice(0, 200)}`);
  return JSON.parse(clean);
}

// ─── SCAN ───────────────────────────────────────────────────────────
async function cmdScan() {
  const t = token();

  // 1. Fetch feed
  console.log('--- FEED (top 20) ---\n');
  const feed = await safeFetch(`${PROXY}/feed?limit=20`);
  const posts = feed.posts || feed.results || [];
  for (const p of posts) {
    const a = p.author?.name ?? '?';
    const title = (p.title ?? '').slice(0, 65);
    const up = p.upvotes ?? 0;
    const cc = p.comment_count ?? 0;
    const submolt = typeof p.submolt === 'object' ? p.submolt?.name : (p.submolt ?? '');
    console.log(`  [${p.id.slice(0, 8)}] ${up}↑ ${cc}💬 s/${submolt} | ${a}: ${title}`);
  }

  // 2. Check our posts for replies
  const ourPostsArg = process.argv.find(a => a.startsWith('--our-posts='));
  const ourPosts = ourPostsArg
    ? ourPostsArg.split('=')[1].split(',')
    : [];

  if (ourPosts.length > 0) {
    console.log('\n--- REPLIES ON OUR POSTS ---\n');
    for (const postId of ourPosts) {
      try {
        const data = await safeFetch(`${API}/posts/${postId}/comments`, { headers: headers(t) });
        const comments = Array.isArray(data) ? data : (data.comments ?? []);
        const others = comments.filter((c: any) =>
          (c.author?.name ?? '') !== OUR_AGENT
        );
        if (others.length === 0) {
          console.log(`  [${postId.slice(0, 8)}] No new comments from others`);
          continue;
        }
        console.log(`  [${postId.slice(0, 8)}] ${others.length} comments from others:`);
        for (const c of others) {
          const a = c.author?.name ?? '?';
          const content = ((c.content ?? '') as string).replace(/\n/g, ' ').slice(0, 150);
          const parent = c.parent_id ? ` (reply to ${(c.parent_id as string).slice(0, 8)})` : '';
          console.log(`    [${(c.id as string).slice(0, 8)}] ${a}${parent}: ${content}`);
        }
      } catch (err) {
        console.error(`  [${postId.slice(0, 8)}] Error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // 3. High-signal filter
  console.log('\n--- HIGH SIGNAL (2+ upvotes or 2+ comments, no spam) ---\n');
  const signal = posts.filter((p: any) =>
    (p.upvotes ?? 0) >= 2 || (p.comment_count ?? 0) >= 2
  ).filter((p: any) => {
    const t = (p.title ?? '').toLowerCase();
    return !t.includes('claw mint') && !t.includes('price update') && !t.includes('auto mint');
  });
  for (const p of signal) {
    const a = p.author?.name ?? '?';
    console.log(`  [${p.id.slice(0, 8)}] ${p.upvotes}↑ ${p.comment_count}💬 | ${a}: ${(p.title ?? '').slice(0, 60)}`);
  }
}

// ─── COMMENT ────────────────────────────────────────────────────────
async function cmdComment(file: string) {
  const t = token();
  const targets: Array<{ postId: string; content: string; parentId?: string; label?: string }> =
    JSON.parse(readFileSync(file, 'utf-8'));

  console.log(`${DRY_RUN ? 'DRY RUN' : 'LIVE'} — ${targets.length} comments\n`);

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const label = c.label ?? `Comment on ${c.postId.slice(0, 8)}`;
    console.log(`${i + 1}/${targets.length}. ${label}`);
    console.log(`  Post: ${c.postId.slice(0, 8)} | ${c.content.length} chars${c.parentId ? ` | reply to ${c.parentId.slice(0, 8)}` : ''}`);

    if (DRY_RUN) {
      console.log(`  [DRY] ${c.content.slice(0, 120)}...\n`);
      continue;
    }

    try {
      const body: Record<string, string> = { content: c.content };
      if (c.parentId) body.parent_id = c.parentId;
      const r = await safeFetch(`${API}/posts/${c.postId}/comments`, {
        method: 'POST',
        headers: headers(t),
        body: JSON.stringify(body),
      });
      console.log(`  Posted: ${r.comment?.id ?? r.id ?? 'ok'}\n`);
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : err}\n`);
    }

    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── POST ───────────────────────────────────────────────────────────
async function cmdPost(file: string) {
  const t = token();
  const data: { title: string; content: string; submolt?: string } =
    JSON.parse(readFileSync(file, 'utf-8'));

  console.log(`${DRY_RUN ? 'DRY RUN' : 'LIVE'} — New post: ${data.title}`);
  console.log(`  ${data.content.length} chars | s/${data.submolt ?? 'general'}`);

  if (DRY_RUN) {
    console.log(`  [DRY] ${data.content.slice(0, 200)}...\n`);
    return;
  }

  try {
    const r = await safeFetch(`${API}/posts`, {
      method: 'POST',
      headers: headers(t),
      body: JSON.stringify({
        title: data.title,
        content: data.content,
        submolt: data.submolt ?? 'general',
      }),
    });
    const post = r.post ?? r;
    console.log(`  Posted: https://www.moltbook.com/post/${post.id}`);
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────
const [, , cmd, arg] = process.argv.filter(a => !a.startsWith('--'));

switch (cmd) {
  case 'scan':
    cmdScan().catch(e => { console.error(e); process.exit(1); });
    break;
  case 'comment':
    if (!arg) { console.error('Usage: moltbook-engage.ts comment <file.json>'); process.exit(1); }
    cmdComment(arg).catch(e => { console.error(e); process.exit(1); });
    break;
  case 'post':
    if (!arg) { console.error('Usage: moltbook-engage.ts post <file.json>'); process.exit(1); }
    cmdPost(arg).catch(e => { console.error(e); process.exit(1); });
    break;
  default:
    console.log(`Moltbook Engage — Agent Zero engagement tool

Commands:
  scan                       Fetch feed + check posts for replies
  comment <targets.json>     Post comments from JSON array
  post <post.json>           Create new post from JSON

Options:
  --dry-run                  Preview without posting
  --our-posts=id1,id2,...    Post IDs to check for replies (scan mode)

Examples:
  npx tsx scripts/moltbook-engage.ts scan
  npx tsx scripts/moltbook-engage.ts comment replies.json --dry-run
  npx tsx scripts/moltbook-engage.ts post announcement.json`);
}
