---
description: Create changeset, verify code quality (pnpm check, pnpm test), fix issues if any, and commit
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Ship It

You are shipping changes for this monorepo. Follow these steps carefully.

## Context

- Git status: !`git status --short`
- Changed packages: !`git diff --name-only HEAD | grep "^packages/" | cut -d'/' -f2 | sort -u`
- Available packages: @ai-sdk-tool/parser, @ai-sdk-tool/eval, @ai-sdk-tool/rxml, @ai-sdk-tool/proxy, @ai-sdk-tool/middleware, @ai-sdk-tool/opencode-plugin
- Changeset config: @.changeset/config.json

## Instructions

### Step 1: Analyze Changes

1. Review the git diff to understand what changed
2. Determine which packages are affected
3. Determine the appropriate version bump:
   - `patch`: Bug fixes, documentation, internal changes
   - `minor`: New features, non-breaking changes
   - `major`: Breaking changes

   **Version bump guidelines**:
   - Use `patch` or `minor` freely based on the actual impact
   - Only use `major` if the user explicitly mentions breaking changes
   - In most cases, `patch` is appropriate even for new features
   - Don't be overly sensitive about version bumps - favor `patch` unless clearly a breaking change

### Step 2: Create Changeset

Create a changeset file in `.changeset/` directory:
- Filename: Use a random kebab-case name (e.g., `happy-tigers-dance.md`)
- Format:
```markdown
---
"@ai-sdk-tool/package-name": patch|minor|major
---

Brief description of what changed (1-2 sentences, in English)
```

If multiple packages changed, list them all in the frontmatter.

### Step 3: Verify Code Quality

Run verification commands and fix any issues:

1. Run `pnpm check` (includes lint + typecheck)
   - If there are errors, fix them
   - Re-run until clean

2. Run `pnpm test`
   - If tests fail, analyze and fix the failures
   - Re-run until all tests pass

### Step 4: Commit

After verification passes:

1. **Selectively stage changes**: Only stage files related to the CURRENT task/context
   - Review the git diff carefully - there may be unrelated changes mixed in from other work
   - Use `git add <specific-files>` instead of `git add .`
   - Only include the changeset file you just created
   - If unclear which changes belong together, ask the user before committing
2. Create a commit with a descriptive message following conventional commits:
   - `feat: ...` for new features
   - `fix: ...` for bug fixes
   - `docs: ...` for documentation
   - `chore: ...` for maintenance
   - `refactor: ...` for refactoring

## Important Notes

- NEVER skip verification steps
- If issues are found, fix them before committing
- Commit message should be in English
- If you can't fix an issue after 3 attempts, stop and report to the user
