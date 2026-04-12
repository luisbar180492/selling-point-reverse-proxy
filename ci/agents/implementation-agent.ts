import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "fs";
import { join, dirname } from "path";
import { z } from "zod";

// ─── Schema ───────────────────────────────────────────────────────────────────

const PlanSliceSchema = z.object({
  objective: z.string(),
  branchType: z.enum(["feature", "fix", "refactor", "cleanup", "chore"]),
  shortDescription: z.string(),
  filesToRead: z.array(z.string()),
  filesToModify: z.array(z.string()),
});

const PlanSchema = z.object({
  notionPageId: z.string(),
  summary: z.string(),
  affectedServices: z.array(z.enum(["auth", "api", "frontend"])),
  slices: z.object({
    auth: PlanSliceSchema.optional(),
    api: PlanSliceSchema.optional(),
    frontend: PlanSliceSchema.optional(),
  }),
});

type PlanSlice = z.infer<typeof PlanSliceSchema>;

// ─── Config ───────────────────────────────────────────────────────────────────

const SERVICE = process.env.SERVICE as "auth" | "api" | "frontend";
const REPO_DIR = join(process.cwd(), "..", "repo");
const MAX_RETRIES = 2;
const DRY_RUN = process.env.DRY_RUN === "true";
const MAX_FILE_CHARS = 60_000;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

const SERVICE_REPO_MAP: Record<string, string> = {
  auth: "selling-point-auth",
  api: "selling-point-api",
  frontend: "selling-point-admin-dashboard",
};

// Commands the agent is allowed to run inside the service repo
const ALLOWED_COMMAND_PREFIXES = [
  "npm run lint",
  "npm test",
  "npm run test",
  "npx prisma validate",
  "npx prisma format",
  "npm run build",
  "npm run type-check",
];

// ─── File system helpers ──────────────────────────────────────────────────────

function readFile(path: string): string {
  const fullPath = join(REPO_DIR, path);
  if (!existsSync(fullPath)) return `Error: file not found: ${path}`;
  if (!readFileSync(fullPath) && true) {
    // just a guard, always readable
  }
  const content = readFileSync(fullPath, "utf-8");
  if (content.length > MAX_FILE_CHARS) {
    return (
      content.slice(0, MAX_FILE_CHARS) +
      `\n...[truncated at ${MAX_FILE_CHARS} chars]`
    );
  }
  return content;
}

function writeFile(path: string, content: string): string {
  const fullPath = join(REPO_DIR, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  return `Written: ${path}`;
}

function listDirectory(path: string): string {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const fullPath = join(REPO_DIR, path);
  if (!existsSync(fullPath)) return `Error: directory not found: ${path}`;
  if (!statSync(fullPath).isDirectory())
    return `Error: not a directory: ${path}`;
  const entries = readdirSync(fullPath, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name),
  );
  return entries
    .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
    .join("\n");
}

function runCommand(command: string): string {
  const allowed = ALLOWED_COMMAND_PREFIXES.some((prefix) =>
    command.startsWith(prefix),
  );
  if (!allowed) {
    return `Error: command not allowed. Permitted prefixes:\n${ALLOWED_COMMAND_PREFIXES.join("\n")}`;
  }
  try {
    const stdout = execSync(command, {
      cwd: REPO_DIR,
      encoding: "utf-8",
      timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stdout || "(command succeeded, no output)";
  } catch (err: any) {
    const stdout: string = err.stdout ?? "";
    const stderr: string = err.stderr ?? err.message ?? "";
    return `FAILED:\nstdout: ${stdout}\nstderr: ${stderr}`;
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

function buildTools(service: string): Anthropic.Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a file from the service repository.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the service repo root",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Write or overwrite a file in the service repository. Always read the file first if it already exists.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the service repo root",
          },
          content: { type: "string", description: "Complete file content" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_directory",
      description: "List files and subdirectories.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to the service repo root",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "run_command",
      description: `Run an allowed shell command in the service repo directory. Allowed prefixes: ${ALLOWED_COMMAND_PREFIXES.join(", ")}`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
        },
        required: ["command"],
      },
    },
    {
      name: "implementation_complete",
      description:
        "Signal that all changes are done, lint passes, and tests pass. Call this only after a successful run_command for both lint and tests.",
      input_schema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "One or two sentences describing what was changed and why",
          },
        },
        required: ["summary"],
      },
    },
  ];
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function runImplAgent(
  anthropic: Anthropic,
  slice: PlanSlice,
  service: string,
): Promise<string> {
  const repoName = SERVICE_REPO_MAP[service] ?? service;
  const isBackend = service !== "frontend";

  const systemPrompt = `You are an expert developer implementing changes in the ${repoName} service.
${isBackend ? "This is a NestJS TypeScript backend service." : "This is a React TypeScript SPA using XState, Navi routing, react-intl, and Tailwind CSS."}

Rules:
- Always read a file before modifying it — never overwrite blindly
- Follow existing code style and patterns exactly
- After making all changes, run lint: npm run lint
- If lint fails, fix all errors and run lint again
- After lint passes, run tests: npm test
- If tests fail, fix them and run again
- Call implementation_complete only after both lint AND tests pass
- Never modify package.json or package-lock.json unless the objective explicitly requires it
- Never commit or push — that is handled outside this agent`;

  const userMessage = `Implement the following changes in ${repoName}:

Objective:
${slice.objective}

Start by reading these files for context:
${slice.filesToRead.map((f) => `- ${f}`).join("\n")}

Files expected to be modified:
${slice.filesToModify.map((f) => `- ${f}`).join("\n")}

Read the relevant files first, implement the changes, run lint then tests, fix any issues, then call implementation_complete.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const systemWithCache = [
    {
      type: "text" as const,
      text: systemPrompt,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const tools = buildTools(service);
  let failedCommandCount = 0;

  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 8096,
      system: systemWithCache as any,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      throw new Error("Agent finished without calling implementation_complete");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const input = block.input as Record<string, any>;

      if (block.name === "read_file") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: readFile(input.path),
        });
      } else if (block.name === "write_file") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: writeFile(input.path, input.content),
        });
      } else if (block.name === "list_directory") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: listDirectory(input.path),
        });
      } else if (block.name === "run_command") {
        const output = runCommand(input.command);
        const failed =
          output.startsWith("FAILED:") || output.startsWith("Error:");
        if (failed) {
          failedCommandCount++;
          if (failedCommandCount > MAX_RETRIES) {
            throw new Error(
              `Exceeded max retries (${MAX_RETRIES}). Last failure:\n${output}`,
            );
          }
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      } else if (block.name === "implementation_complete") {
        const summary = input.summary as string;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Implementation accepted.",
        });
        messages.push({ role: "user", content: toolResults });
        return summary;
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

async function createBranch(branchName: string) {
  const git = simpleGit(REPO_DIR);
  await git.checkout(["-b", branchName]);
  console.log(`Created branch: ${branchName}`);
}

async function commitAndPush(branchName: string, commitMessage: string) {
  const git = simpleGit(REPO_DIR);
  await git.addConfig("user.email", "ci-agent@selling-point.local");
  await git.addConfig("user.name", "Selling Point CI Agent");
  await git.add(".");

  const status = await git.status();
  if (status.files.length === 0) {
    throw new Error("No files changed after implementation. Failing.");
  }

  await git.commit(commitMessage);
  await git.push("origin", branchName);
  console.log(`Pushed branch: ${branchName}`);
}

async function openPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  title: string,
  body: string,
): Promise<string> {
  const pr = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: "master",
    draft: false,
  });
  return pr.data.html_url;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SERVICE || !["auth", "api", "frontend"].includes(SERVICE)) {
    throw new Error("SERVICE env var must be one of: auth, api, frontend");
  }
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is required");
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required");

  const planPath =
    process.env.PLAN_JSON_PATH ?? join(process.cwd(), "..", "plan.json");
  const rawPlan = JSON.parse(readFileSync(planPath, "utf-8"));
  const plan = PlanSchema.parse(rawPlan);

  if (!plan.affectedServices.includes(SERVICE)) {
    console.log(`Service "${SERVICE}" is not in affectedServices — skipping.`);
    return;
  }

  const slice = plan.slices[SERVICE];
  if (!slice) {
    console.log(`No slice found for service "${SERVICE}" — skipping.`);
    return;
  }

  const repoName = SERVICE_REPO_MAP[SERVICE];
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "";

  // Build branch name: {type}/{ticketShort}-{service}-{description}
  const ticketShort = plan.notionPageId
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();
  const branchName = `${slice.branchType}/${ticketShort}-${SERVICE}-${slice.shortDescription}`;
  const prTitle = `${slice.branchType}: ${slice.shortDescription.replace(/-/g, " ")} [${SERVICE}]`;

  console.log(`Service:     ${SERVICE}`);
  console.log(`Repo:        ${repoName}`);
  console.log(`Branch:      ${branchName}`);
  console.log(`Objective:   ${slice.objective}`);
  console.log(`DRY_RUN:     ${DRY_RUN}`);

  // Create feature branch
  await createBranch(branchName);

  // Run the implementation agent
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const summary = await runImplAgent(anthropic, slice, SERVICE);
  console.log(`\nImplementation complete: ${summary}`);

  if (DRY_RUN) {
    console.log("DRY_RUN=true — skipping commit, push, and PR creation.");
    return;
  }

  const notionPageUrl = `https://notion.so/${plan.notionPageId.replace(/-/g, "")}`;
  const commitMessage = `${slice.branchType}: ${summary}\n\nNotion ticket: ${notionPageUrl}\nAutomated implementation by Claude agent.`;

  await commitAndPush(branchName, commitMessage);

  const octokit = new Octokit({ auth: process.env.GH_TOKEN });
  const prBody = [
    `## Summary`,
    summary,
    ``,
    `## Notion Ticket`,
    notionPageUrl,
    ``,
    `## Affected files`,
    slice.filesToModify.map((f) => `- \`${f}\``).join("\n"),
    ``,
    `_Automated implementation by Claude agent._`,
  ].join("\n");

  const prUrl = await openPR(
    octokit,
    owner,
    repoName,
    branchName,
    prTitle,
    prBody,
  );
  console.log(`PR opened: ${prUrl}`);

  // Export outputs for the bump-submodules job
  const ghOutput = process.env.GITHUB_OUTPUT ?? "";
  if (ghOutput) {
    appendFileSync(ghOutput, `pr_url=${prUrl}\n`);
    appendFileSync(ghOutput, `branch_name=${branchName}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
