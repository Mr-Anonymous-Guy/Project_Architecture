/**
 * sync.js — Portfolio Auto-Sync Engine (Simplified)
 *
 * How it works:
 *   1. Reads README.md and extracts every GitHub repo URL already listed.
 *   2. Fetches all public repos from the GitHub API.
 *   3. Compares the two lists.
 *   4. Any repo on GitHub that is NOT already in the README gets added
 *      to the single "Recently Added Projects" section.
 *   5. Any repo that IS already listed stays untouched — no rewriting.
 *
 * Security:
 *   - Token read exclusively from GITHUB_TOKEN env var (never hardcoded).
 *   - Empty API payloads abort immediately (prevents accidental wipe).
 *   - Descriptions sanitised to prevent Markdown table breakage.
 *
 * Usage (CI):    GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} node sync.js
 * Usage (local): GITHUB_TOKEN=ghp_xxx node sync.js --dry-run
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Configuration ───────────────────────────────────────────────────────────

const GITHUB_USERNAME = 'Mr-Anonymous-Guy';
const API_BASE = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 5;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const README_PATH = resolve(__dirname, 'README.md');

const DRY_RUN = process.argv.includes('--dry-run');

// Repos to always exclude (meta repos, profile readme, this repo)
const EXCLUDED_REPOS = new Set([
  'mr-anonymous-guy',   // Profile README repo
  'project_architecture', // This repo itself
  '.github',            // GitHub config repo
]);

// ─── Security: Token Validation ──────────────────────────────────────────────

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('✖ GITHUB_TOKEN environment variable is not set.');
  process.exit(1);
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Sanitise a description string so it doesn't break Markdown tables.
 */
function sanitiseDescription(desc) {
  if (!desc) return 'No description provided';
  return desc
    .replace(/\|/g, '—')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Extract all GitHub repo URLs already present in the README.
 * Returns a Set of lowercase repo names (e.g. "novashell", "nexterm").
 */
function extractExistingRepoNames(readmeContent) {
  const repoNames = new Set();
  // Match patterns like: [RepoName](https://github.com/Mr-Anonymous-Guy/RepoName)
  const regex = /\[([^\]]+)\]\(https:\/\/github\.com\/Mr-Anonymous-Guy\/([^)]+)\)/gi;
  let match;
  while ((match = regex.exec(readmeContent)) !== null) {
    repoNames.add(match[2].toLowerCase());
  }
  return repoNames;
}

// ─── GitHub API Client ───────────────────────────────────────────────────────

/**
 * Fetch all public repositories with pagination.
 */
async function fetchAllRepos() {
  const allRepos = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${API_BASE}/users/${GITHUB_USERNAME}/repos?type=public&per_page=${PER_PAGE}&page=${page}&sort=created&direction=desc`;
    console.log(`📡 Fetching page ${page}...`);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Project-Architecture-Sync/1.0',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`✖ GitHub API error (${response.status}): ${body}`);
      process.exit(1);
    }

    // Rate limit awareness
    const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '60', 10);
    if (remaining < 5) {
      const resetTime = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10);
      const waitMs = Math.max(0, resetTime * 1000 - Date.now()) + 1000;
      console.warn(`⚠ Rate limit low (${remaining}). Waiting ${Math.round(waitMs / 1000)}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const repos = await response.json();
    if (!Array.isArray(repos) || repos.length === 0) break;
    allRepos.push(...repos);
    if (repos.length < PER_PAGE) break;
  }

  return allRepos;
}

// ─── Markdown Generation ─────────────────────────────────────────────────────

/**
 * Generate a Markdown table for a list of repos.
 */
function generateTable(repos) {
  if (repos.length === 0) {
    return [
      '| Project | Description | Repo |',
      '| :--- | :--- | :--- |',
      '| *No new repositories detected* | — | — |',
    ].join('\n');
  }

  const header = '| Project | Description | Repo |\n| :--- | :--- | :--- |';
  const rows = repos
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((repo) => {
      const desc = sanitiseDescription(repo.description);
      const link = `[${repo.name}](${repo.html_url})`;
      return `| ${repo.name} | ${desc} | ${link} |`;
    });

  return [header, ...rows].join('\n');
}

// ─── README Patcher ──────────────────────────────────────────────────────────

/**
 * Replace content between START_NEW_PROJECTS and END_NEW_PROJECTS anchors.
 */
function replaceNewProjectsBlock(content, tableMarkdown) {
  const startTag = '<!-- START_NEW_PROJECTS -->';
  const endTag = '<!-- END_NEW_PROJECTS -->';

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) {
    console.error('✖ Anchor block <!-- START_NEW_PROJECTS --> / <!-- END_NEW_PROJECTS --> not found in README.');
    process.exit(1);
  }

  const before = content.substring(0, startIdx + startTag.length);
  const after = content.substring(endIdx);

  return `${before}\n${tableMarkdown}\n${after}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔄 Portfolio Auto-Sync Engine v2.0 (Simplified)');
  console.log(`   User: ${GITHUB_USERNAME}`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // 1. Read current README
  let readme;
  try {
    readme = readFileSync(README_PATH, 'utf-8');
  } catch (err) {
    console.error(`✖ Cannot read README.md: ${err.message}`);
    process.exit(1);
  }

  // 2. Extract all repo names already listed anywhere in the README
  const existingNames = extractExistingRepoNames(readme);
  console.log(`📄 Found ${existingNames.size} repos already in README\n`);

  // 3. Fetch all public repos from GitHub
  const allRepos = await fetchAllRepos();

  // Safety: abort on empty payload
  if (!allRepos || allRepos.length === 0) {
    console.error('✖ SAFETY ABORT: GitHub API returned 0 repositories. README was NOT modified.');
    process.exit(1);
  }

  console.log(`✔ Fetched ${allRepos.length} public repositories from GitHub\n`);

  // 4. Filter: find repos that are NOT already in README and NOT excluded
  const newRepos = allRepos.filter((repo) => {
    if (repo.archived || repo.fork) return false;
    if (EXCLUDED_REPOS.has(repo.name.toLowerCase())) return false;
    if (existingNames.has(repo.name.toLowerCase())) return false;
    return true;
  });

  console.log(`📌 New repos to add: ${newRepos.length}`);
  if (newRepos.length > 0) {
    newRepos.forEach((r) => console.log(`   + ${r.name}`));
  } else {
    console.log('   (none — README is fully up to date)');
  }
  console.log('');

  // 5. Generate table and patch README
  const table = generateTable(newRepos);
  readme = replaceNewProjectsBlock(readme, table);

  // 6. Write or dry-run
  if (DRY_RUN) {
    console.log('── DRY RUN: No file written ──');
    console.log('Generated "Recently Added Projects" table:');
    console.log(table);
  } else {
    writeFileSync(README_PATH, readme, 'utf-8');
    console.log(`✔ README.md updated at ${README_PATH}`);
  }
}

main().catch((err) => {
  console.error('✖ Unhandled error:', err.message);
  process.exit(1);
});
