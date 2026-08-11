// Protocol compliance check (linear-ticketing-sop §9) — runs on every PR profile.
// Verifies: PR title is "FTP-<n>: <summary>" (squash-merge title convention),
// body references its ticket with a NON-closing keyword (Refs FTP-<n>), and
// never uses auto-close keywords (merge precedes verification in this model).
import { readFileSync } from "node:fs";

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("protocol-check: GITHUB_EVENT_PATH missing (not a PR context?)");
  process.exit(1);
}
const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pr = event.pull_request;
if (!pr) {
  console.error("protocol-check: no pull_request in event payload");
  process.exit(1);
}

const title = pr.title ?? "";
const body = pr.body ?? "";
const errors = [];

if (!/^FTP-\d+: .+/.test(title)) {
  errors.push(`PR title must be "FTP-<n>: <summary>", got: "${title}"`);
}
if (!/Refs FTP-\d+/.test(body)) {
  errors.push('PR body must reference its ticket with "Refs FTP-<n>" (non-closing).');
}
if (/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+FTP-\d+/i.test(body)) {
  errors.push("PR body must not use auto-close keywords (Fixes/Closes/Resolves FTP-n) — tickets close via verification, not merge.");
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log("protocol-check: OK");
// ftp-62 verifier probe (temp)
