# Contributing to Vivant

First off, thank you for considering contributing to Vivant! It's people like you who make open-source tools better for everyone.

Vivant is a GPL-3.0 licensed Linux EPUB reader built with Tauri (Rust) and vanilla JavaScript. To ensure a smooth collaboration, please take a moment to review the following guidelines.

## Code Style & Guidelines

Consistency is key to keeping our codebase maintainable. Please follow these principles when making changes:

### JavaScript (Frontend)

- **Language:** We use modern, vanilla JavaScript (ES6+). No build tools, transpilers, or UI frameworks (like React or Vue) are used.
- **Indentation:** Use 2 spaces for indentation. Never use tabs.
- **Documentation:** Use JSDoc comments (`/** @param {type} ... */`) to document types, function parameters, and return values. This serves as our primary source of type safety and developer tooling.
- **Structure:** Group related logic within files using clear comment headers (e.g., `// --- State ---`, `// --- Helpers ---`).
- **Variables & Naming:** Use `camelCase` for variables and functions. Prefer `let` and `const`.
- **Async Logic:** Prefer Promises and `async/await` syntax over traditional callbacks.
- **Cleanliness:** Remove all debugging artifacts like `console.log` statements before opening a pull request.

### Rust (Backend)

- **Standard Tooling:** We strictly enforce standard Rust formatting. Before submitting code, run `cargo fmt` to format (which enforces 4 spaces for indentation) and `cargo clippy -- -D warnings` to catch common mistakes.
- **Naming Conventions:** Use standard Rust styles—`snake_case` for variables, commands, and functions; `PascalCase` for structs, traits, and enums.
- **Error Handling:** Prevent application panics (`unwrap()`, `expect()`). Handle errors gracefully using internal `Result` types, and map them to a serializable `Result<T, String>` at the Tauri command boundary level using `.to_string()`. Use early returns (`?`) aggressively.
- **Tauri Integration:** Ensure Tauri commands are self-contained, inject dependencies (like database pools) cleanly using `tauri::State`, and are logically grouped within `src-tauri/src/commands.rs`.

## Workflow

We use GitHub to track issues and merge changes. Here is the best way to get your contribution through:

### Reporting Bugs & Opening Issues

- **Search First:** Check if the issue or feature request has already been reported in the issue tracker.
- **Use Templates:** Always use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) or [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) templates when creating issues.
- **Be Specific:** Provide your OS, Vivant version, and clear steps to reproduce the issue.
- **Logs:** If the application crashes, please run the application from your terminal and attach any relevant logs or output to help us debug.

### Submitting Features or Fixes

- **Fork & Branch:** Create a descriptively named branch (e.g., `fix/sidebar-overlap` or `feat/custom-fonts`).
- **Commit Messages:** Use clear, imperative statements (e.g., "Add feature", instead of "Added feature").
- **One Change per PR:** Keep pull requests focused. If you have multiple unrelated changes, please open separate pull requests for each.

## Hard Rules

To maintain project integrity, we enforce the following strict rules:

- **Tauri APIs:** All `invoke()` calls must stay exclusively inside `src/api.js`. Never scatter them across other files.
- **Commands:** Add new Tauri commands to `src-tauri/src/commands.rs`, and register them in `src-tauri/src/lib.rs`.
- **Return Types:** Commands must always return `Result<T, String>`.
- **Naming:** Always use `snake_case` for all commands.
- **Security:** Use parameterized SQL everywhere. Never use string interpolation on user input.
- **Privacy:** No network calls or telemetry are allowed without an explicit decision from the project maintainers.
- **Licensing:** Verify that all new dependencies are strictly GPL-3.0 compatible before they are introduced.

## Development Environment

We use Docker to ensure a consistent development environment for all contributors. Please refer to [DOCKER.md](DOCKER.md) for basic setup instructions.

### Troubleshooting Docker

If you encounter **"Permission denied (os error 13)"** or **"npm EACCES"** errors, this is typically caused by running Docker commands with `sudo`. This creates root-owned files in volumes.

To solve this, clean up your host machine's build directories first:

```bash
sudo docker compose down -v
sudo rm -rf node_modules src-tauri/target
```

Then, rebuild the image without using cache. **Do not use `sudo` for these commands:**

```bash
docker compose build --no-cache
docker compose up -d
```

## Code Comments

We follow established best practices for documentation:

1. **Explain Why, Not What:** Provide the context and intent behind your implementation decisions rather than restating what the code does.
2. **Be Non-duplicative:** Add value beyond what the code communicates on its own.
3. **Clarify, Do Not Confuse:** Use clear, precise language.
4. **Keep Comments Brief:** If your comments are getting too extensive, consider refactoring the code instead.
5. **Explain Non-obvious Code:** Focus documentation on edge cases, workarounds, and complex business logic.

## Before Submitting a Pull Request

Please make sure to run the project's tests and builds completely before submitting. If for any reason certain tests or builds could not be run locally, proactively state what wasn't run and why in your PR description.

```bash
npm run test
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```
