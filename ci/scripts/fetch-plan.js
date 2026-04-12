#!/usr/bin/env node
/**
 * Fetches the implementation plan from a Notion page and writes plan.json.
 * Also sets GitHub Actions outputs: affects_auth, affects_api, affects_frontend.
 *
 * Usage: node fetch-plan.js
 * Env:   NOTION_API_KEY, NOTION_PAGE_ID, GITHUB_OUTPUT (set automatically in GH Actions)
 */

const { Client } = require("@notionhq/client");
const { writeFileSync, appendFileSync } = require("fs");

const PLAN_MARKER = "<!-- AGENT_PLAN_JSON -->";

async function main() {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId) throw new Error("NOTION_PAGE_ID is required");
  if (!process.env.NOTION_API_KEY)
    throw new Error("NOTION_API_KEY is required");

  const notion = new Client({ auth: process.env.NOTION_API_KEY });

  console.log(`Fetching plan from Notion page: ${pageId}`);
  const blocks = await notion.blocks.children.list({ block_id: pageId });

  let planJson = null;
  for (const block of blocks.results) {
    if (block.type === "code") {
      const text = block.code?.rich_text?.[0]?.plain_text ?? "";
      if (text.includes(PLAN_MARKER)) {
        planJson = text.replace(PLAN_MARKER, "").trim();
        break;
      }
    }
  }

  if (!planJson) {
    throw new Error(
      "No plan block found on Notion page. Run the plan workflow first.",
    );
  }

  const plan = JSON.parse(planJson);
  const services = plan.affectedServices ?? [];

  console.log(`Affected services: ${services.join(", ")}`);

  // Write plan.json for impl-agent to consume
  const outPath = process.env.PLAN_JSON_OUTPUT ?? "plan.json";
  writeFileSync(outPath, planJson, "utf-8");
  console.log(`plan.json written to ${outPath}`);

  // Set GitHub Actions outputs
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(ghOutput, `affects_auth=${services.includes("auth")}\n`);
    appendFileSync(ghOutput, `affects_api=${services.includes("api")}\n`);
    appendFileSync(
      ghOutput,
      `affects_frontend=${services.includes("frontend")}\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
