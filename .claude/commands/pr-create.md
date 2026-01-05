---
description: Create a pull request using gh CLI with comprehensive description based on git diff from main branch
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Create Pull Request

You are creating a pull request for the current branch against main. Follow these steps carefully.

## Context

- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Diff from main: !`git diff --stat main..HEAD`
- Available packages: @ai-sdk-tool/parser, @ai-sdk-tool/eval, @ai-sdk-tool/rxml, @ai-sdk-tool/proxy, @ai-sdk-tool/middleware

## Instructions

### Step 1: Analyze Changes

1. Get the full diff from main branch to understand what changed
2. Identify the main purpose/type of changes:
   - New features (feat)
   - Bug fixes (fix)
   - Documentation (docs)
   - Refactoring (refactor)
   - Maintenance (chore)

### Step 2: Create PR Title

Create a concise, descriptive title following conventional commit format with package scope:

1. **Identify affected packages**: Check which packages were modified in the changes
2. **Add scope**: Include the package name in parentheses if changes affect a specific package
3. **Use conventional prefixes**:
   - `feat(scope):` for new features
   - `fix(scope):` for bug fixes
   - `docs(scope):` for documentation
   - `refactor(scope):` for refactoring
   - `chore(scope):` for maintenance

Examples:
- `feat(parser): add new tool parsing protocol`
- `fix(eval): resolve streaming timeout issue`
- `docs(proxy): update API documentation`
- `refactor(rxml): optimize memory usage in parser`
- `chore(middleware): update dependencies`

**For multiple packages:**
- Choose the **primary affected package** as scope (usually the one with most changes)
- If truly cross-cutting changes, use a general scope or omit scope entirely
- Examples: `feat(parser): update tool parsing across packages` or `chore: update dependencies across monorepo`

### Step 3: Create PR Description

Write a comprehensive description that includes:

1. **Summary**: 1-2 sentences explaining what this PR does
2. **Changes**: Bullet points of key changes made
3. **Testing**: What was tested (if applicable)
4. **Breaking Changes**: Any breaking changes (if any)

Use the git diff content to inform the description. Focus on the "why" and "what" rather than just listing files.

### Step 4: Create PR

Use `gh pr create` command with the title and description:

```bash
gh pr create --title "YOUR_TITLE_HERE" --body "$(cat <<'EOF'
## Summary
Brief summary of changes

## Changes
- Change 1
- Change 2

## Testing
- Tests performed
- Verification steps

## Breaking Changes
- Any breaking changes or none
EOF
)"
```

### Step 5: Verify

After creating the PR, verify it was created successfully and the description is accurate.

## Important Notes

- Always create PRs against main branch
- PR title should be in English
- PR description should be comprehensive but concise
- If the changes are complex, ensure the description clearly explains the impact
- Use conventional commit prefixes in the title when appropriate
