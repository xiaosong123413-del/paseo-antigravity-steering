# Antigravity Steering for Paseo

Adds active-task steering and document editing to Antigravity CLI. The provider retains the standard stop-and-resume behavior.

Independent community plugin. Not an official Google or Paseo release.

> **Security:** the CLI runs with `--dangerously-skip-permissions`. It can execute commands and modify files on the daemon host without asking. Copy-first document editing is a workflow, not a filesystem sandbox. Only use trusted hosts and review the code before enabling the plugin.

## Install

Requirements: Paseo 0.11.1+, Node.js 22+, and an authenticated Antigravity CLI that supports `PreInvocation` and `PostInvocation` hooks. Document editing also needs Python 3.11+ and the packages in `requirements-documents.txt`. The live-tested host was Windows; macOS/Linux live behavior has not been verified.

Run on the computer hosting the Paseo daemon:

```sh
git clone https://github.com/xiaosong123413-del/paseo-antigravity-steering.git
cd paseo-antigravity-steering
npm ci
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-antigravity-steering
```

Enable trusted plugins in Paseo settings if they are disabled. The repository is a source release, not an npm package or a Paseo registry listing. Keep the checkout at a stable path because hooks reference it.

### Configure steering

Merge the named entry from [examples/hooks.json](examples/hooks.json) into `~/.gemini/config/hooks.json` on the daemon host. Replace the example Node executable and checkout paths with real absolute paths. Preserve other hooks. On Windows, forward slashes in JSON paths are convenient; retain quoting around paths with spaces.

Both invocation hooks are required. The plugin supplies the session-specific `PASEO_AGY_STEERING_URL`; do not configure it yourself. Outside this provider's sessions, the hook returns an empty response without opening a connection.

### Configure document editing

Use a Python environment of your choice. For example:

```sh
python -m venv .venv
```

Install using that environment's Python executable:

```sh
/absolute/path/to/python -m pip install -r requirements-documents.txt
```

Merge the `agents.providers.antigravity-steering` entry from [examples/provider.json](examples/provider.json) into the daemon's `~/.paseo/config.json`, replacing all example paths. Preserve existing providers and environment settings. The document Python executable must be the one where the packages were installed. Configure writable output and temporary directories according to your device's storage policy. No credentials or proxy changes are required by the plugin.

```sh
paseo reload --json
paseo plugin reload antigravity-steering-provider
paseo plugin ls
```

Require the plugin to show `running`. A daemon restart is not needed. Start a new **Antigravity Steering** chat. Without document runtime configuration, text and image prompts still work, but document uploads return a configuration error.

## Use

Choose **Antigravity Steering** when creating a Paseo chat. The original built-in **Antigravity** provider and its existing chats are separate and unchanged.

- Steering queues a user message for the next model invocation or the completion of an in-flight invocation. It does not kill a running tool or interrupt token generation.
- Interrupt cancels the active CLI process tree, discards unread steering messages, and resumes the same conversation with the new prompt.
- If a message is admitted after the final invocation hook has returned, it continues the same Paseo task in the existing CLI conversation. It is not discarded.

The CLI still runs in full-access mode, as the upstream Paseo Antigravity provider does.

## Document editing

Upload DOCX, XLSX, PPTX, PDF, Markdown, TXT, or CSV, or give the agent an explicit local file path. Uploaded files are passed as complete binary files, not flattened into prompt text. The provider supplies the available editing libraries and the document IO workflow to the agent on every prompt, including steering.

- Default: make a working copy, edit it in its original format, reopen and validate it, and return a link to the new file. Outputs persist after the conversation closes.
- Original-file edit: explicitly ask to modify the original and give its path on the daemon computer. The helper validates the edited copy and checks the original's SHA-256 before atomic replacement. It refuses an upload-only reference, an externally changed original, or invalid output.
- An upload is a server-side copy. Its filename cannot establish where the original lives on a phone or another computer. The plugin does not guess the original's path.
- This is an agent workflow, not an OS write sandbox. Antigravity retains full access; the helper's protections apply when using the supplied editing workflow.

The provider environment configures `PASEO_DOCUMENT_PYTHON`, `PASEO_DOCUMENT_HELPER`, `PASEO_DOCUMENT_OUTPUT`, and `PASEO_DOCUMENT_TEMP`. The plugin does not change proxy configuration. Document contents processed by the agent may be sent to the selected model service; local parsing does not make the entire task offline.

`server/document_io.py prepare SOURCE --output-root DIRECTORY` returns a working path and an edit manifest. The agent edits the copy using python-docx, openpyxl, python-pptx, or PyMuPDF. `publish MANIFEST` validates and returns the new file; `publish MANIFEST --overwrite-original` commits an explicitly authorized local-original edit. Returned file links use absolute paths. Download requests must be scoped to the artifact's directory, not a different workspace.

Limits: legacy DOC/XLS/PPT require conversion; encrypted documents need appropriate credentials; scans need image reading or OCR. Complex embedded objects, tracked changes, macros, formulas, and layout require format-specific checks. openpyxl preserves formulas but does not calculate them. Structural validation is not a guarantee of visual fidelity or lossless editing for every possible document.

## Components

- `server/provider.ts`: provider registration (`antigravity-steering`).
- `server/internal/session.ts`: native conversation and Paseo turn lifecycle.
- `server/internal/steering.ts`: session-scoped loopback message queue. It validates both a random capability and native conversation identity.
- `server/hook-client.cjs`: Antigravity hook process. It does nothing when the provider-specific environment variable is absent.
- `server/internal/prompt.ts`: upload-path validation and document workflow instructions.
- `server/document_io.py`: copy-first preparation, file validation, and explicit original-file publishing.

The installed global Antigravity hook entry is named `paseo-antigravity-steering`. Its `PreInvocation` and `PostInvocation` handlers execute `server/hook-client.cjs` with `pre` and `post` respectively. The provider supplies `PASEO_AGY_STEERING_URL` only to its own CLI sessions. No polling is used.

The plugin uses the existing Antigravity CLI, credentials, and provider environment. It does not install or redistribute Antigravity itself.

## Verification

`npm test` covers ordered single delivery, conversation isolation, post-invocation continuation, cancellation cleanup, capability rejection, and document attachment handling. `npm run typecheck` checks TypeScript. Tests use the system temporary directory by default; set `PASEO_TEST_TEMP` to select another existing directory.

On 2026-10-10, live verification through the local Paseo 0.11.1 daemon passed with Gemini 3.8 Flash Medium:

| Test | Observed result |
| --- | --- |
| Raw CLI stdin while a tool runs | Original task completed first; later input became a separate turn |
| Hook injection during a tool | Subsequent original command skipped; updated instruction applied before another model invocation |
| Paseo steering | One Paseo turn, zero cancellations, one tool call, `PASEO_STEER_VERIFIED` |
| Paseo interrupt | Old turn canceled, new turn started, `PASEO_INTERRUPT_VERIFIED CONTEXT_1010` |

Verification used the real Paseo API and CLI, not browser clicks. Host-specific live acceptance scripts and conversation identifiers are not included in this public repository.

### Document acceptance on 2026-10-10

Real daemon uploads and Gemini 3.8 Flash Medium edited all five fixture formats. Independent checks, not the model's success claim, verified:

| Format | New file and explicit original edit | Preserved fixture properties |
| --- | --- | --- |
| DOCX | Both passed | Bold run, table and header |
| XLSX | Both passed | Bold cell, formula and second sheet |
| PPTX | Both passed | Bold run, second shape and slide count |
| PDF | Both passed | Remaining text and page count; new-file render visually checked |
| Markdown | Both passed | Remaining text and CRLF line endings |

All five local source files and daemon upload copies were byte-identical before and after the default new-file run. All five returned new files downloaded through Paseo's authenticated token flow and matched the on-disk bytes. An initial download test used the agent's unrelated workspace and correctly failed its path boundary; scoping the request to each output directory passed without changing server permissions. UI clicks and full Word/PowerPoint page renders were not tested.

`npm run test:documents` covers all five formats in both write modes, upload/original separation, external modifications, corrupt output, unique output paths, and Unicode names. Run it with the document libraries installed in the `python` on your test PATH, or invoke that environment's Python with `-X utf8 -m unittest discover -s test -p test_document_io.py -v`. Fixtures are synthetic and contain no user documents.

## Sources

- [Antigravity invocation hooks](https://www.antigravity.google/docs/hooks/)
- [Paseo provider plugin contract](https://paseo.sh/docs/plugins/providers.md)
- [Paseo plugin publishing](https://paseo.sh/docs/plugins/publishing.md)

## Attribution

The CLI transport, catalog, timeline mapping, and base session implementation are derived from Paseo 0.11.1's `plugins/antigravity-provider`, licensed under Apache-2.0. Changes add a separate provider identity, invocation-hook steering, and document editing. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Third-party dependencies keep their own licenses. In particular, PyMuPDF is available under AGPL v3 or an Artifex commercial license; this repository's Apache-2.0 license does not replace those terms. See the [PyMuPDF licensing notice](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright) before redistribution or commercial integration. No third-party binaries, credentials, user documents, or local configuration files are included.
