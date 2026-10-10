# Antigravity Steering

Adds active-task steering, interrupt-and-resume, and document editing to Antigravity CLI in Paseo. Select the separate **Antigravity Steering** provider for new chats; existing built-in Antigravity chats are unchanged.

Steering injects instructions at the next model-invocation boundary without killing the current tool. Interrupt stops the current execution and resumes the same conversation. This is not token-by-token interruption.

Document editing supports DOCX, XLSX, PPTX, PDF, Markdown, TXT, and CSV. It preserves complete uploaded files and uses Python document libraries. Edits default to a new file. Replacing a local original requires an explicit instruction and its path on the daemon computer; an upload alone is not an original-file reference.

Requires Paseo 0.11.1 or later, an authenticated Antigravity CLI with invocation hooks, Node.js, and hook setup on the daemon host. Document editing additionally requires Python 3.11 or later and the configured document libraries. Live acceptance was performed on Windows with Paseo 0.11.1; other hosts require verification.

The CLI runs with full filesystem and command access. Copy-first editing is a workflow, not a sandbox. Document contents may be sent to the selected model service. Legacy Office formats, encrypted documents, scans, and complex embedded objects need extra handling. Existing proxy settings are not changed.
