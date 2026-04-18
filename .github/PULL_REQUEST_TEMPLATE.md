## Description

<!-- Describe your changes in detail here. -->

## Related Issue

<!-- Link to the issue this PR addresses: e.g. "Fixes #123" -->

## Motivation and Context

<!-- Why is this change required? What problem does it solve? -->

## Hard Rules Checklist

- [ ] I have reviewed the `CONTRIBUTING.md` file.
- [ ] I placed all `invoke()` calls exclusively in `src/api.js`.
- [ ] I placed new Tauri commands in `src-tauri/src/commands.rs` and registered them in `src-tauri/src/lib.rs`.
- [ ] My commands return `Result<T, String>` and use `snake_case`.
- [ ] I used parameterized SQL queries (no string interpolation).
- [ ] I verified no network calls or telemetry are introduced.
- [ ] I verified all new dependencies are GPL-3.0 compatible.

## Pre-Merge Checks

<!-- Please run the following checks before submitting. -->

- [ ] `npm run test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `npm run build`

### Omitted Checks

- [ ] I did not run some checks (explain which and why below):

## Screenshots (if appropriate)

<!-- Add screenshots or screen recordings showcasing the change. -->
