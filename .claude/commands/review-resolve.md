---
description: Read PR reviews, apply fixes, ship changes, and resolve all review threads
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Todowrite, Todoread
---

# /review-resolve

Handles the complete PR review workflow: reads reviews, applies fixes, ships changes, and resolves reviews.

## Context

- Current branch: !`git branch --show-current`
- PR number: !`gh pr list --head "$(git branch --show-current)" --json number | jq -r '.[0].number // empty'`
- If no PR found, abort with message.

## Instructions

### Step 1: Fetch and Analyze Reviews

1. Get all PR review comments: `gh api repos/minpeter/ai-sdk-tool-call-middleware/pulls/{PR_NUMBER}/comments`
2. Parse the comments to identify issues to fix.
3. For each comment, determine if it's actionable (code fix needed) or informational.

### Step 2: Apply Fixes

1. For actionable comments, analyze the suggested changes.
2. Apply fixes to the code using Edit tool.
3. Run `lsp_diagnostics` on changed files to ensure no errors.
4. Test the changes if possible.

### Step 3: Verify and Ship Changes

**CRITICAL: Verification before proceeding**

1. Run `pnpm check` and verify it passes completely.
   - If `pnpm check` fails, FIX ALL ERRORS before continuing.
   - Do NOT proceed if there are any lint, type, or other errors.
   - Pre-existing errors unrelated to your changes should be noted but not block progress.

2. Run `pnpm test` and verify all tests pass.
   - If tests fail due to your changes, fix them.
   - Pre-existing test failures should be noted.

3. **Changeset decision (IMPORTANT)**:
   - Only create a changeset if the review fixes introduce NEW functionality or breaking changes.
   - Do NOT create a changeset for:
     - Fixing issues that were already covered by existing changesets in the PR
     - Minor comment additions or documentation clarifications
     - Code style fixes that don't change behavior
   - When in doubt, check existing changesets in `.changeset/` directory first.

4. Commit the changes with descriptive message.

### Step 4: Resolve Reviews

1. Fetch review thread IDs: `gh api graphql -f query='{ repository(owner: "minpeter", name: "ai-sdk-tool-call-middleware") { pullRequest(number: {PR_NUMBER}) { reviewThreads(first: 100) { nodes { id, isResolved } } } } }'`
2. Resolve all threads: For each unresolved thread, use `gh api graphql -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -F id={thread_id}`

### Step 5: Handle Unresolved Reviews (Optional)

If user specifies unresolved reviews:
1. For each specified review, post a comment explaining why not resolved.
2. Use `gh pr comment {PR_NUMBER} --body "Comment text"`

## Important Notes

- Always confirm with user before applying major changes.
- If fixes are complex, create todos for tracking.
- Commit message in English.
- If any step fails, stop and report.
