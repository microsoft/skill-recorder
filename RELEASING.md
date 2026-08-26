# Releasing Skill Recorder

Skill Recorder uses semantic versions and two distinct release channels:

1. **Source-only releases** are the default. GitHub publishes the tagged
   repository source, and users build an exact commit locally with the
   commit-pinned installers.
2. **Binary releases** are optional. They must be built with the repository's
   `npm run dist*` commands and accompanied by the complete, version-matched
   compliance bundle.

Never attach `dist/`, `dist-electron/`, `node_modules/`, or an application
assembled by `install.ps1` or `install.sh` to a release.

## 1. Prepare a release pull request

Start from the latest `main` and choose the next semantic version:

- patch (`0.1.1`) for compatible fixes;
- minor (`0.2.0`) for compatible functionality;
- major (`1.0.0`) for incompatible behavior after the project reaches 1.0.

Update both `package.json` and `package-lock.json` without creating a tag:

```sh
npm version 0.2.0 --no-git-tag-version
```

Replace `0.2.0` with the chosen version. Summarize user-visible changes in the
pull request. If dependencies or bundled assets changed, perform the review
below before updating any compliance policy hash.

### Dependency and asset review

Run:

```sh
npm run fix:lockfile-registry
npm run check:lockfile
npm ci --ignore-scripts=false --dangerously-allow-all-scripts=false --strict-allow-scripts
npm run compliance:licenses
```

Inspect:

- `.compliance/LICENSE-INVENTORY.json`;
- `.compliance/THIRD-PARTY-LICENSES.txt`;
- `THIRD-PARTY-NOTICES.md`;
- changes to `package-lock.json`;
- the exact-version approvals and explicit denials in `package.json#allowScripts`;
- every new or changed image, font, model, native library, executable, and
  copied source file.

The committed lockfile must use canonical `registry.npmjs.org` resolved URLs.
Microsoft contributors may fetch through a configured internal mirror, but
internal feed URLs must never be committed. Review every new dependency install
script before adding an exact-version approval; explicitly deny scripts that
are not required.

The compliance scripts intentionally reject unreviewed component versions and
materials. Do not fix such a failure by blindly replacing a version or hash.
Review the new license, notices, redistribution terms, corresponding-source
requirements, and upstream provenance first.

| Change | Required review |
| --- | --- |
| GitHub Copilot SDK or CLI | Re-read that exact version's terms and notices; confirm unmodified bundling remains permitted; update the reviewed policy version. |
| Electron or Chromium | Review the Electron archive and checksums, Chromium notices, FFmpeg revision/source/patches, and every supported platform hash. |
| Sharp or sharp-libvips | Review package licenses, native dependency versions, build repositories, patches, source archives, and relinking instructions. |
| ONNX Runtime | Review the exact release/development revision, license, notices, native packages, and source reference. |
| Tesseract.js, Tesseract.js-core, or tessdata | Review the exact npm versions, WASM build commit and submodules, embedded-library notices, language-data commit/hash, and fixed source archives. |
| Artistic-2.0 package | Retain the package notice and complete Artistic-2.0 text; include valid source instructions or the exact Standard Version source. |
| New native or copyleft component | Add exact notices, canonical license text, complete corresponding source, build scripts/patches, and relinking instructions where required. |
| Font, image, model, recording, or other asset | Record its provenance and written redistribution authorization; do not assume application code licenses cover assets. |

If a new obligation cannot be met, do not merge or release the dependency.

## 2. Validate the release candidate

Run the existing checks:

```sh
npm test
npm run build
npm run typecheck:evals
npm run compliance:licenses
```

For a binary candidate, also generate the full bundle:

```sh
npm run compliance:prepare
```

The pull request must pass:

- Windows x64 and ARM64 license, test, build, package, and architecture checks;
- macOS full corresponding-source preparation, test, and build checks;
- Ubuntu license, test, and build checks;
- commit-pinned source-installer checks on Windows, macOS, and Ubuntu.

Resolve every compliance failure. Never disable or bypass a compliance check to
publish a release.

## 3. Merge and freeze the release commit

Merge the release pull request into `main`, then wait for the workflows on
the resulting `main` commit to pass. Record the exact commit:

```sh
git fetch origin main
release_commit="$(git rev-parse origin/main)"
printf '%s\n' "$release_commit"
```

The release tag and every installation command must identify this commit. Do
not use a branch name or a mutable tag in an installer command.

Create an annotated tag only after the commit passes:

```sh
version="v0.2.0"
git tag -a "$version" "$release_commit" -m "Skill Recorder $version"
git push origin "$version"
```

Do not move or reuse a published tag. Protect release tags in repository
settings. If a release is defective, publish a new patch version.

## 4. Calculate installer-script hashes

Calculate hashes from the exact release commit's Git blobs, not working-tree
files. This avoids stale checkouts and local line-ending conversion. Replace
the final argument with the full 40-character release commit SHA. The command
works in PowerShell, macOS, and Ubuntu:

```sh
node -e 'const {execFileSync}=require("node:child_process");const {createHash}=require("node:crypto");const commit=process.argv[1];if(!/^[0-9a-f]{40}$/i.test(commit))throw new Error("full release commit SHA required");for(const file of ["install.ps1","install.sh"]){const data=execFileSync("git",["cat-file","blob",commit+":"+file]);console.log(createHash("sha256").update(data).digest("hex")+"  "+file)}' FULL_40_CHARACTER_RELEASE_COMMIT_SHA
```

Publish both hashes in the GitHub Release notes. A user following the
inspect-first instructions in `INSTALL.md` must be able to compare the
downloaded script with these values.

## 5. Publish the source-only GitHub Release

Source-only is the recommended release format. Do not attach installers or
portable binaries. GitHub's automatically generated archives contain the
tagged repository source but not `node_modules` or downloaded runtimes.

Release notes must include:

- version and full release commit SHA;
- SHA-256 values for `install.ps1` and `install.sh`;
- user-visible changes;
- the commit-pinned Windows and macOS/Ubuntu commands from `INSTALL.md`;
- a clear statement that the release is source-only;
- important upgrade, security, or compatibility notes.

After preparing a notes file:

```sh
gh release create "v0.2.0" \
  --verify-tag \
  --title "Skill Recorder v0.2.0" \
  --notes-file release-notes.txt
```

Do not commit the temporary release-notes file.

## 6. Optional binary release

Binary publication is a separate decision. The supported release targets are
**Windows x64**, **Windows ARM64**, and **macOS arm64**; every other platform,
including Linux and macOS x64, is a source install (see `INSTALL.md`). The
compliance tooling refuses to prepare a redistributable bundle on an
unsupported target.

Build each artifact on its native operating system and architecture:

```sh
npm ci
npm run dist
npm run dist:win:x64
npm run dist:win:arm64
npm run dist:portable:mac
npm run dist:portable:win
```

Run only the command applicable to that native machine. Outputs are written to
`release/`. The build must complete the `afterPack` compliance gate.

Before attaching a binary:

1. Confirm it was built from the tagged commit with an unchanged lockfile.
2. Verify its operating-system and CPU architecture.
3. Confirm `resources/compliance/` contains exact notices, legal texts,
   corresponding source, patches, hashes, and relinking instructions.
4. Archive the generated `.compliance` directory as a separate companion asset.
5. Attach the binary and its matching compliance archive to the same release.
6. Publish SHA-256 values for every attached asset.
7. Preserve the compliance archive for as long as the binary remains available.
8. Disclose whether the binary is unsigned, ad-hoc signed, or Authenticode /
   Developer ID signed.

The manual **Portable builds** workflow produces unsigned preview artifacts and
matching compliance artifacts. Download and verify them before deciding to
publish them. An Actions artifact is not itself a GitHub Release.

## 7. Post-release verification

On clean supported machines:

1. Download each installer script by the full release commit SHA.
2. Compare its SHA-256 with the release notes.
3. Run with `SKILL_RECORDER_NO_LAUNCH=1`.
4. Confirm dependency installation and the platform license inventory succeed.
5. Launch Skill Recorder and exercise recording, analysis, and skill creation.
6. Confirm update and uninstall instructions in `INSTALL.md`.

Check that the GitHub Release tag still resolves to the recorded commit and
that all source archives, hashes, notes, and optional compliance assets remain
available.

## 8. Correcting a published release

Never silently replace an asset or move a release tag.

- For incorrect notes, edit the notes and document the correction.
- For a defective script, dependency, compliance bundle, or binary, mark the
  affected release as unsuitable and publish a new patch release.
- If an asset creates a legal or security risk, remove the affected binary,
  retain an audit record, and publish corrected materials under a new version.
