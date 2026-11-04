import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadReviewedSkillRegistry } from "../src/skill-registry.ts";
import { reviewedCompletionRules } from "../src/workspace-postconditions.ts";

const IMAGE = "registry.cloudflare.com/89a95a21e6a6b7c15bbd8e148a6c6242/hygge-workspace@sha256:ae26f5d92b203d94f18bc13f1c121975459053c3b34d9ee2ea664d68f01d55ff";

function config(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

function value(text: string, key: string): string | null {
  return text.match(new RegExp(`"${key}":\\s*"([^"]+)"`))?.[1] ?? null;
}

function encodedJsonValue(text: string, key: string): string {
  const encoded = text.match(new RegExp(`"${key}":\\s*"((?:\\\\.|[^"\\\\])*)"`))?.[1];
  assert.ok(encoded, key);
  return JSON.parse(`"${encoded}"`) as string;
}

test("staging and production activate retained V2 with isolated pinned bindings", () => {
  for (const [file, namespace, bucket] of [
    ["wrangler.staging.jsonc", "hygge-staging", "hygge-workspace-checkpoints-staging"],
    ["wrangler.production.jsonc", "hygge-production", "hygge-workspace-checkpoints-production"],
  ] as const) {
    const text = config(file);
    assert.equal(value(text, "HYGGE_WORKSPACE_MODE"), "retained-v2", file);
    assert.equal(value(text, "HYGGE_WORKSPACE_NAMESPACE"), namespace, file);
    assert.equal(value(text, "HYGGE_WORKSPACE_IMAGE"), IMAGE, file);
    assert.match(text, new RegExp(`"images":\\s*\\{\\s*"base":\\s*\\{\\s*"image":\\s*"${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), file);
    assert.match(text, new RegExp(`\\{\\s*"binding":\\s*"WORKSPACE_CHECKPOINTS",\\s*"bucket_name":\\s*"${bucket}"\\s*\\}`), file);
  }
});

test("reviewed Wave 4 artifacts are staging-only; production sharing and write completion fail closed", () => {
  const staging = config("wrangler.staging.jsonc");
  assert.match(staging, /"HYGGE_SKILL_REGISTRY":\s*"\{.*wave4-jobs/);
  assert.match(staging, /"HYGGE_WORKSPACE_POSTCONDITIONS":\s*"\[\{.*hygge-wave4-jobs/);
  const registry = loadReviewedSkillRegistry(JSON.parse(encodedJsonValue(staging, "HYGGE_SKILL_REGISTRY")));
  assert.equal(registry.siteIdForOrigin("https://hygge-wave4-jobs.lemberg-89a.workers.dev"), "wave4-jobs");
  const rules = reviewedCompletionRules(encodedJsonValue(staging, "HYGGE_WORKSPACE_POSTCONDITIONS"));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].outcome, "apply");

  const production = config("wrangler.production.jsonc");
  assert.equal(production.includes("HYGGE_SKILL_REGISTRY"), false);
  assert.equal(production.includes("HYGGE_WORKSPACE_POSTCONDITIONS"), false);
});

test("deploy jobs ensure each checkpoint bucket before deploying", () => {
  const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const bucket of ["hygge-workspace-checkpoints-staging", "hygge-workspace-checkpoints-production"]) {
    assert.match(ci, new RegExp(bucket));
    assert.match(ci, /wrangler r2 bucket create/);
  }
});

test("workspace image publishing is manual and reports an immutable digest without deploying", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/workspace-image.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /docker build --platform linux\/amd64 -f container\/Dockerfile/);
  assert.match(workflow, /wrangler containers push/);
  assert.match(workflow, /RepoDigests/);
  assert.equal(workflow.includes("wrangler deploy"), false);
});

test("deploy jobs apply the additive shared-skills V2 migration to both databases", () => {
  const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /wrangler d1 execute hygge-staging .*migrations\/0008_shared_skills_v2\.sql/);
  assert.match(ci, /wrangler d1 execute hygge-production .*migrations\/0008_shared_skills_v2\.sql/);
});
