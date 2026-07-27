```markdown
# edgesync Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `edgesync` TypeScript codebase. You'll learn how to structure files, write imports and exports, follow commit message conventions, and implement and run tests using `vitest`. These practices ensure consistency, maintainability, and ease of collaboration within the project.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `syncManager.ts`, `dataFetcher.test.ts`

### Import Style
- Use **relative imports** for referencing modules within the project.
  - Example:
    ```typescript
    import { fetchData } from './dataFetcher'
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In syncManager.ts
    export function syncData() { ... }
    export const SYNC_INTERVAL = 5000
    ```

### Commit Messages
- Follow **Conventional Commits** with the `feat` prefix for new features.
  - Example:
    ```
    feat: add incremental sync option to manager
    ```

## Workflows

### Adding a New Feature
**Trigger:** When implementing a new feature or module  
**Command:** `/add-feature`

1. Create a new file using camelCase naming (e.g., `newFeature.ts`).
2. Use relative imports to include dependencies.
3. Export all functions or constants using named exports.
4. Write a test file named `newFeature.test.ts` alongside the implementation.
5. Commit your changes using the `feat:` prefix and a concise description.
   - Example: `feat: implement new synchronization strategy`

### Running Tests
**Trigger:** To verify code correctness and run all tests  
**Command:** `/run-tests`

1. Ensure all test files follow the `*.test.ts` pattern.
2. Run tests using the `vitest` framework.
   - Example command:
     ```
     npx vitest run
     ```
3. Review the output and address any failing tests.

## Testing Patterns

- All tests are written in TypeScript using the `vitest` framework.
- Test files are named with the `.test.ts` suffix and placed alongside the source files.
- Example test file structure:
  ```typescript
  // dataFetcher.test.ts
  import { fetchData } from './dataFetcher'

  test('fetchData returns expected result', async () => {
    const result = await fetchData()
    expect(result).toBeDefined()
  })
  ```

## Commands
| Command        | Purpose                                             |
|----------------|-----------------------------------------------------|
| /add-feature   | Scaffold and commit a new feature/module            |
| /run-tests     | Run all vitest tests in the codebase                |
```
