import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const packageJsonSchema = z.object({
  devDependencies: z.object({
    "@changesets/cli": z.string(),
  }),
});

const workflowSchema = z.object({
  jobs: z.object({
    release: z.object({
      steps: z.array(
        z.object({
          name: z.string(),
          uses: z.string().optional(),
          with: z.record(z.string(), z.unknown()).optional(),
          if: z.string().optional(),
        })
      ),
    }),
  }),
});

const workflowExpressionPrefix = "$";

describe("release changeset workflow contract", () => {
  it("uses the Changesets v2 contract when the release workflow runs", () => {
    // Given: the package manifest and release workflow consumed by CI
    const packageJson = packageJsonSchema.parse(
      JSON.parse(readFileSync("package.json", "utf8"))
    );
    const workflow = workflowSchema.parse(
      parse(readFileSync(".github/workflows/release-changeset.yml", "utf8"))
    );

    // When: the Changesets action and dependent cleanup steps are selected
    const actionStep = workflow.jobs.release.steps.find(
      (step) => step.uses === "changesets/action@v2"
    );
    const cleanupSteps = workflow.jobs.release.steps.filter(
      (step) =>
        step.name.startsWith("Cleanup") ||
        step.name.startsWith("Commit cleanup")
    );

    // Then: all machine-consumed values form one compatible v2 release contract
    expect
      .soft(packageJson.devDependencies["@changesets/cli"].startsWith("3."))
      .toBe(true);
    expect.soft(actionStep?.with).toEqual({
      "github-token": `${workflowExpressionPrefix}{{ secrets.GITHUB_TOKEN }}`,
      "pr-base-branch": `${workflowExpressionPrefix}{{ github.ref_name }}`,
      "publish-script": "pnpm ci:release",
      "push-with-git-cli": true,
      "version-script": "pnpm ci:version",
    });
    expect
      .soft(cleanupSteps.map((step) => step.if))
      .toEqual([
        "steps.changesets.outputs.has-changesets == 'true'",
        "steps.changesets.outputs.has-changesets == 'true'",
      ]);
  });
});
