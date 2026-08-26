# Repository instructions for coding agents

## Pull requests target the active **release branch**, not `main`

Ongoing work in this repository lands on the **current release branch**, not `main`.
Release branches are named `release/<semver>` — currently **`release/0.3.0`**, the
highest-versioned `release/*` branch on `origin`. `main` trails the release branch and
only advances when a version is cut and merged (see [`RELEASING.md`](../RELEASING.md)).

Unless a task explicitly says otherwise:

- **Base new work on the current release branch**, not `main`:

  ```sh
  git fetch origin
  git switch -c <your-branch> origin/release/0.3.0
  ```

- **Open pull requests with the current release branch as the base**, not `main`:

  ```sh
  gh pr create --repo microsoft/skill-recorder --base release/0.3.0 --head <your-branch>
  ```

- **Find the current release branch** (pick the highest semver) with:

  ```sh
  git ls-remote --heads origin 'release/*'
  ```

Target `main` only for the release merge described in [`RELEASING.md`](../RELEASING.md).
