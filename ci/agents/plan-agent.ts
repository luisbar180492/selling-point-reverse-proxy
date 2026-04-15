import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { z } from "zod";

// ─── Schema ───────────────────────────────────────────────────────────────────

const PlanSliceSchema = z.object({
  objective: z.string().min(1),
  branchType: z.enum(["feature", "fix", "refactor", "cleanup", "chore"]),
  shortDescription: z
    .string()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "must be kebab-case, e.g. add-discount-field",
    ),
  filesToRead: z.array(z.string()),
  filesToModify: z.array(z.string()),
});

const PlanSchema = z.object({
  notionPageId: z.string().min(1),
  summary: z.string().min(1),
  affectedServices: z.array(z.enum(["auth", "api", "frontend"])).min(1),
  slices: z.object({
    auth: PlanSliceSchema.optional(),
    api: PlanSliceSchema.optional(),
    frontend: PlanSliceSchema.optional(),
  }),
});

type Plan = z.infer<typeof PlanSchema>;

// ─── Config ───────────────────────────────────────────────────────────────────

const PLAN_MARKER = "<!-- AGENT_PLAN_JSON -->";
const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const MAX_FILE_CHARS = 50_000;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".next",
]);

// ─── Notion helpers ───────────────────────────────────────────────────────────

async function fetchPageContext(notion: NotionClient, pageId: string) {
  const page = (await notion.pages.retrieve({ page_id: pageId })) as any;

  const titleProp =
    page.properties?.Name?.title ?? page.properties?.title?.title ?? [];
  const title = titleProp[0]?.plain_text ?? "Untitled";
  const description =
    page.properties?.Description?.rich_text?.[0]?.plain_text ?? "";

  // Scan page blocks for an existing plan code block
  const blocks = await notion.blocks.children.list({ block_id: pageId });
  let existingPlanJson: string | null = null;
  let existingPlanBlockId: string | null = null;

  for (const block of blocks.results as any[]) {
    if (block.type === "paragraph") {
      const text: string = (block.paragraph?.rich_text ?? [])
        .map((rt: any) => rt.plain_text ?? "")
        .join("");
      if (text.includes(PLAN_MARKER)) {
        existingPlanJson = text.replace(PLAN_MARKER, "").trim();
        existingPlanBlockId = block.id as string;
        break;
      }
    }
  }

  // Fetch page comments
  const commentsResp = await notion.comments.list({ block_id: pageId });
  const commentTexts = (commentsResp.results as any[])
    .map((c) => c.rich_text?.[0]?.plain_text ?? "")
    .filter(Boolean);

  return {
    title,
    description,
    existingPlanJson,
    existingPlanBlockId,
    commentTexts,
  };
}

// Notion's rich_text objects have a 2000-character limit each.
// Split the content into chunks and map each to a rich_text entry.
function toRichTextChunks(content: string) {
  const CHUNK = 2000;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK) {
    chunks.push(content.slice(i, i + CHUNK));
  }
  return chunks.map((c) => ({ type: "text", text: { content: c } }));
}

async function upsertPlanBlock(
  notion: NotionClient,
  pageId: string,
  planJson: string,
  existingBlockId: string | null,
) {
  const content = `${PLAN_MARKER}\n${planJson}`;
  const richText = toRichTextChunks(content);

  if (existingBlockId) {
    await (notion.blocks as any).update({
      block_id: existingBlockId,
      paragraph: { rich_text: richText },
    });
  } else {
    await notion.blocks.children.append({
      block_id: pageId,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: richText },
        },
      ] as any,
    });
  }
}

async function updateStatus(
  notion: NotionClient,
  pageId: string,
  statusName: string,
) {
  const statusProp = process.env.NOTION_STATUS_PROPERTY ?? "Status";
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [statusProp]: { status: { name: statusName } },
    } as any,
  });
}

// ─── File system tools ────────────────────────────────────────────────────────

function readFile(path: string): string {
  const fullPath = path.startsWith("/") ? path : join(REPO_ROOT, path);
  if (!existsSync(fullPath)) return `Error: file not found: ${path}`;
  if (!statSync(fullPath).isFile()) return `Error: not a file: ${path}`;
  const content = readFileSync(fullPath, "utf-8");
  if (content.length > MAX_FILE_CHARS) {
    return (
      content.slice(0, MAX_FILE_CHARS) +
      `\n...[truncated at ${MAX_FILE_CHARS} chars]`
    );
  }
  return content;
}

function listDirectory(dirPath: string): string {
  const fullPath = dirPath.startsWith("/") ? dirPath : join(REPO_ROOT, dirPath);
  if (!existsSync(fullPath)) return `Error: directory not found: ${dirPath}`;
  if (!statSync(fullPath).isDirectory())
    return `Error: not a directory: ${dirPath}`;
  const entries = readdirSync(fullPath, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name),
  );
  return entries
    .map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
    .join("\n");
}

function buildRepoTree(
  root: string,
  maxDepth = 3,
  depth = 0,
  prefix = "",
): string {
  if (depth > maxDepth || !existsSync(root)) return "";
  const entries = readdirSync(root, { withFileTypes: true }).filter(
    (e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name),
  );
  return entries
    .map((e) => {
      const line = `${prefix}${e.name}`;
      if (e.isDirectory()) {
        const children = buildRepoTree(
          join(root, e.name),
          maxDepth,
          depth + 1,
          prefix + "  ",
        );
        return `${line}/\n${children}`;
      }
      return line;
    })
    .join("\n");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path is relative to the repo root or absolute.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the repo root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories in a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the repo root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "generate_plan",
    description:
      "Submit the final implementation plan. Call this once you have read enough code to be confident about the changes needed.",
    input_schema: {
      type: "object",
      properties: {
        notionPageId: { type: "string" },
        summary: {
          type: "string",
          description:
            "One paragraph describing all changes across all services",
        },
        affectedServices: {
          type: "array",
          items: { type: "string", enum: ["auth", "api", "frontend"] },
          description:
            "Only include a service if it genuinely needs code changes",
        },
        slices: {
          type: "object",
          description: "One entry per affected service",
          properties: {
            auth: { $ref: "#/definitions/slice" },
            api: { $ref: "#/definitions/slice" },
            frontend: { $ref: "#/definitions/slice" },
          },
          definitions: {
            slice: {
              type: "object",
              properties: {
                objective: {
                  type: "string",
                  description: "What must be implemented in this service",
                },
                branchType: {
                  type: "string",
                  enum: ["feature", "fix", "refactor", "cleanup", "chore"],
                  description:
                    "feature=new functionality, fix=bug, refactor=code quality, cleanup=dead code, chore=config/deps",
                },
                shortDescription: {
                  type: "string",
                  description:
                    "Kebab-case, max 5 words, describes the change. Used in the branch name.",
                },
                filesToRead: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Files the implementation agent should read for context",
                },
                filesToModify: {
                  type: "array",
                  items: { type: "string" },
                  description: "Files that will be created or changed",
                },
              },
              required: [
                "objective",
                "branchType",
                "shortDescription",
                "filesToRead",
                "filesToModify",
              ],
            },
          },
        },
      },
      required: ["notionPageId", "summary", "affectedServices", "slices"],
    },
  },
];

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function runPlanAgent(
  anthropic: Anthropic,
  pageId: string,
  title: string,
  description: string,
  existingPlan: string | null,
  comments: string[],
): Promise<Plan> {
  const repoTree = buildRepoTree(REPO_ROOT);
  const isRevision = existingPlan !== null && comments.length > 0;

  const systemPrompt = `You are a senior software architect generating implementation plans for a POS (point-of-sale) system.

The codebase is a monorepo with 3 services (all Git submodules):
- selling-point-auth/        NestJS auth service (JWT issuance + forward-auth validation, CASL scopes)
- selling-point-api/         NestJS GraphQL API (resolvers in src/resolvers/{entity}/, Prisma ORM)
- selling-point-admin-dashboard/  React SPA (XState state machines, Navi routing, react-intl, Tailwind)

Repository file tree:
\`\`\`
${repoTree}
\`\`\`

Rules for generating the plan:
- Use read_file and list_directory to understand relevant code before deciding what to change
- Only include a service in affectedServices if it needs actual code changes
- shortDescription: kebab-case, max 5 words, describes the change itself (not the ticket title)
- branchType: feature (new functionality), fix (bug), refactor (code quality), cleanup (dead code), chore (config/deps/migrations only)
- filesToRead: files the implementation agent must read to understand context before coding
- filesToModify: specific files that will be created or changed (not test files unless tests genuinely need updating)
- Do not include selling-point-db submodule paths directly — Prisma schema is accessed via selling-point-auth/selling-point-db/ or selling-point-api/selling-point-db/`;

  const userMessage = isRevision
    ? `Revise the implementation plan based on the reviewer's feedback.

Ticket title: ${title}
Ticket description: ${description}

Current plan:
${existingPlan}

Reviewer comments (oldest first):
${comments.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Explore the code as needed, then call generate_plan with the updated plan.`
    : `Generate an implementation plan for this customer feedback ticket.

Ticket title: ${title}
Ticket description: ${description}

Explore the relevant parts of the codebase, then call generate_plan with your plan.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // Cache the system prompt — stays warm across the planning→implementation gap
  const systemWithCache = [
    {
      type: "text" as const,
      text: systemPrompt,
      cache_control: { type: "ephemeral" as const },
    },
  ];

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
      throw new Error("Agent finished without calling generate_plan");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const input = block.input as Record<string, any>;
      let result: string;

      if (block.name === "read_file") {
        result = readFile(input.path);
      } else if (block.name === "list_directory") {
        result = listDirectory(input.path);
      } else if (block.name === "generate_plan") {
        const parsed = PlanSchema.safeParse(input);
        if (!parsed.success) {
          result = `Validation failed. Fix these errors and call generate_plan again:\n${JSON.stringify(parsed.error.issues, null, 2)}`;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
          continue;
        }
        // Valid plan — accept it and return
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Plan accepted.",
        });
        messages.push({ role: "user", content: toolResults });
        return parsed.data;
      } else {
        result = `Unknown tool: ${block.name}`;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId)
    throw new Error("NOTION_PAGE_ID environment variable is required");
  if (!process.env.NOTION_API_KEY)
    throw new Error("NOTION_API_KEY is required");
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is required");

  const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`Fetching Notion page: ${pageId}`);
  const {
    title,
    description,
    existingPlanJson,
    existingPlanBlockId,
    commentTexts,
  } = await fetchPageContext(notion, pageId);

  console.log(`Ticket: "${title}"`);
  console.log(`Mode: ${existingPlanJson ? "revision" : "first run"}`);
  console.log(`Comments: ${commentTexts.length}`);

  const plan = await runPlanAgent(
    anthropic,
    pageId,
    title,
    description,
    existingPlanJson,
    commentTexts,
  );

  const planJson = JSON.stringify(plan, null, 2);
  console.log("\nPlan generated:");
  console.log(planJson);

  console.log("\nPosting plan to Notion...");
  await upsertPlanBlock(notion, pageId, planJson, existingPlanBlockId);

  const waitingStatus = process.env.NOTION_WAITING_VALUE ?? "Waiting Approval";
  console.log(`Updating status to "${waitingStatus}"...`);
  await updateStatus(notion, pageId, waitingStatus);

  // Write artifact for the implement workflow to reference
  writeFileSync("plan.json", planJson, "utf-8");
  console.log("Done. plan.json written.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
