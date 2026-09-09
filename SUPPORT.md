# Support

## How to file issues and get help

Skill Recorder is a community-supported, open-source project rather than an officially
supported Microsoft product — see the [Disclaimer](README.md#disclaimer). Support is
community-based and best-effort.

This project uses [GitHub Issues](https://github.com/microsoft/skill-recorder/issues) to
track bugs and feature requests. Please search the existing issues before filing a new one
to avoid duplicates. For anything new, open an Issue.

Before filing, it's worth checking:

- [`README.md`](README.md) — requirements, what gets captured, and how analysis works
- [`INSTALL.md`](INSTALL.md) — installation, including the Windows source installer
- [`WINDOWS-VALIDATION.md`](WINDOWS-VALIDATION.md) and
  [`docs/windows-capture.md`](docs/windows-capture.md) — Windows-specific capture notes

### What to include in a bug report

- Your OS and version (macOS, Windows 11, or Ubuntu) and architecture
- The Skill Recorder commit you installed or built from
- Whether you're using an installer or a source checkout
- What you expected to happen versus what actually happened
- Any relevant error text from the app

**Debug bundles.** Each recording in the Library has a small download icon in its session
header that packages that session into a `.zip` alongside environment diagnostics. Because
it's complete, it includes your capture data — screenshots, screen video, narration audio,
and the analysis. Give it a quick review and remove anything private before sharing, and
please don't attach one to a public GitHub issue. If a maintainer needs it, they'll point
you to a private channel to send it.

## Security issues

Please do **not** report security vulnerabilities through public GitHub issues. Follow the
process in [`SECURITY.md`](SECURITY.md) instead.

## Microsoft Support Policy

Support for Skill Recorder is limited to the resources listed above. It is not covered by
Microsoft Customer Service & Support (CSS) or any Microsoft support program or service
level agreement.
