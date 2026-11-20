// Generated from Platform scripts/ci/check_committed_data.mjs at aca66df89672dea07023d18850f0ac6caab59e16.
// Regenerate from the approved Platform revision. Edit the source there.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const maxBuffer = 256 * 1024 * 1024;
const documentExtension = /\.(?:xlsx|xls|xlsm|xlsb|xltx|xlt|xla|csv|tsv|pdf|doc|docx|dot|dotx|rtf|ppt|pptx|numbers|pages|key|ods|odt|parquet|avro)$/i;
const sha = /^[a-f0-9]{40}$/;
const uuid = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

class ScanError extends Error {}

let gitDirectory;
let gitEnvironment = process.env;

function git(...args) {
  return execFileSync("git", args, {
    cwd: gitDirectory,
    env: gitEnvironment,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function validSsn(value) {
  const digits = value.replace(/\D/g, "");
  const area = Number(digits.slice(0, 3));
  return digits.length === 9 && area > 0 && area !== 666 && area < 900
    && Number(digits.slice(3, 5)) > 0 && Number(digits.slice(5)) > 0
    && !/^(?:123456789|999999999)$/.test(digits) && !/^\d{5}-\d{4}$/.test(value);
}

function luhn(value) {
  let sum = 0;
  let double = false;
  for (const part of [...value.replace(/\D/g, "")].reverse()) {
    const digit = Number(part) * (double ? 2 : 1);
    sum += digit > 9 ? digit - 9 : digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function personalEmail(value) {
  return !(/@(?:example|test)\.(?:com|org|net)$/i.test(value)
    || /@[^@\s]+\.(?:test|example|invalid|localhost)$/i.test(value)
    || /@users\.noreply\.github\.com$/i.test(value)
    || /^git@(?:github\.com|gitlab\.com|bitbucket\.org|ssh\.github\.com)$/i.test(value));
}

function validIban(value) {
  let remainder = 0;
  for (const character of value.slice(4) + value.slice(0, 4)) {
    const code = character.charCodeAt(0);
    remainder = (code < 65 ? remainder * 10 + code - 48 : remainder * 100 + code - 55) % 97;
  }
  return remainder === 1;
}

// Check the same four categories as the existing repository guards.
const patterns = [
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi, personalEmail],
  ["SSN", /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, validSsn],
  ["credit card", /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, luhn],
  ["credit card", /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, luhn],
  ["IBAN", /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}\b/g, validIban],
];

function piiKinds(text) {
  const identifiers = [...text.matchAll(uuid)];
  const kinds = new Set();
  for (const [kind, expression, validate] of patterns) {
    for (const match of text.matchAll(expression)) {
      const containsMatch = identifier => identifier.index <= match.index
        && match.index + match[0].length <= identifier.index + identifier[0].length;
      if (validate(match[0]) && !identifiers.some(containsMatch)) kinds.add(kind);
    }
  }
  return kinds;
}

function displayedPath(path) {
  return JSON.stringify(piiKinds(path).size ? "<path redacted>" : path);
}

function changeBase(head, event) {
  switch (process.env.GITHUB_EVENT_NAME) {
    case "push":
      if (event.after !== head || !sha.test(event.before ?? "")) throw new ScanError("Cannot identify the pushed range.");
      return /^0{40}$/.test(event.before) ? emptyTree : event.before;
    case "pull_request": {
      const [base, proposed, ...other] = commitParents(head);
      if (other.length || !proposed || proposed !== event.pull_request?.head?.sha || !sha.test(base ?? "")) {
        throw new ScanError("Cannot verify the pull request's tested merge.");
      }
      return base;
    }
    case "merge_group":
      if (event.merge_group?.head_sha !== head || !sha.test(event.merge_group?.base_sha ?? "")) {
        throw new ScanError("Cannot identify the merge queue range.");
      }
      return event.merge_group.base_sha;
    case "workflow_dispatch":
      return commitParents(head)[0] ?? emptyTree;
    default:
      throw new ScanError("Data protection does not support this GitHub event.");
  }
}

function commitParents(head) {
  const headers = git("cat-file", "commit", head).split("\n\n", 1)[0];
  return [...headers.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
}

function scanGitHubChange() {
  const head = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const server = process.env.GITHUB_SERVER_URL;
  const token = process.env.DATA_SCAN_TOKEN;
  if (!sha.test(head ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || server !== "https://github.com" || !token) {
    throw new ScanError("Cannot establish the GitHub repository and commit for this scan.");
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  gitDirectory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "data-protection-"));
  try {
    // This is a read-only fetch. Do not materialize or execute any repository files.
    gitEnvironment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
    git("init", "--bare", "--quiet");
    git("remote", "add", "origin", `${server}/${repository}.git`);
    git("config", "remote.origin.promisor", "true");
    git("config", "remote.origin.partialclonefilter", "blob:none");
    const fetch = revision => git("fetch", "--no-tags", "--filter=blob:none", "origin", revision);
    fetch(head);
    const base = changeBase(head, event);
    if (base !== emptyTree && base !== head) {
      try {
        git("cat-file", "-e", base + "^{commit}");
      } catch {
        fetch(base);
      }
    }
    scan(head, base);
  } finally {
    rmSync(gitDirectory, { recursive: true, force: true });
  }
}

function scanChange(head, base, findings) {
  const paths = git("diff", "--name-only", "--diff-filter=ACMR", "--no-renames", "-z", base, head, "--");
  for (const path of paths.split("\0").filter(Boolean)) {
    if (documentExtension.test(path)) {
      findings.add(`Data document added or changed at ${displayedPath(path)}`);
    }
  }

  let path = "<unknown>";
  let lineNumber = 0;
  let inHunk = false;
  // Candidate-controlled attributes must not be able to disable text diffs.
  const patch = git(`--attr-source=${emptyTree}`, "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--");
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      path = "<unknown>";
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      inHunk = true;
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (!inHunk || line.startsWith("-") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      for (const kind of piiKinds(line.slice(1))) {
        findings.add(`High-risk ${kind} added at ${displayedPath(path)}:${lineNumber}`);
      }
    }
    lineNumber++;
  }
}

function scan(head, base) {
  const findings = new Set();
  scanChange(head, base, findings);
  if (base !== emptyTree) {
    // A merge retains the introduced commits even if a later commit deleted
    // a file or line. Also check their patches, excluding work already on base.
    const commits = git("rev-list", "--parents", head, "^" + base).trim();
    for (const row of commits.split("\n").filter(Boolean)) {
      const [commit, parent = emptyTree, ...otherParents] = row.split(" ");
      if (commit === head && parent === base) continue;
      if (otherParents.length === 0) {
        scanChange(commit, parent, findings);
      } else {
        // An introduced merge can contain conflict-resolution edits. Only
        // report findings absent from all parents, so inherited work is not
        // reclassified as an addition by the selected parent.
        const parentFindings = new Set();
        scanChange(commit, parent, parentFindings);
        for (const other of otherParents) {
          if (!parentFindings.size) break;
          const otherFindings = new Set();
          scanChange(commit, other, otherFindings);
          for (const finding of parentFindings) {
            if (!otherFindings.has(finding)) parentFindings.delete(finding);
          }
        }
        for (const finding of parentFindings) findings.add(finding);
      }
    }
  }
  if (findings.size) {
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    console.log("Passed data-document and high-risk text checks.");
  }
}

try {
  if (process.argv.length === 2) {
    scanGitHubChange();
  } else {
    const [base, head = git("rev-parse", "HEAD").trim()] = process.argv.slice(2);
    if (!sha.test(base) || !sha.test(head) || process.argv.length > 4) {
      throw new ScanError("Expected exact base and head commit SHAs.");
    }
    scan(head, base);
  }
} catch (error) {
  // Git stderr and event bodies may contain raw paths or sensitive values.
  console.error(error instanceof ScanError ? error.message : "Could not read or scan the expected change range.");
  process.exitCode = 2;
}
