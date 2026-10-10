import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { PromptFiles } from "../server/internal/prompt.js";

const tempRoot = process.env.PASEO_TEST_TEMP || os.tmpdir();
const runtime = {
  PASEO_DOCUMENT_PYTHON: path.join(tempRoot, "python"),
  PASEO_DOCUMENT_HELPER: path.resolve("server/document_io.py"),
  PASEO_DOCUMENT_OUTPUT: path.join(tempRoot, "antigravity-documents"),
  PASEO_DOCUMENT_TEMP: tempRoot,
};

test("uploaded documents retain their exact bytes and file names", async () => {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(path.join(tempRoot, "paseo-document-test-"));
  const source = path.join(dir, "upload.bin");
  const bytes = Buffer.from([0, 255, 80, 75, 13, 10]);
  await writeFile(source, bytes);
  const files = new PromptFiles(runtime);
  try {
    const prompt: ProviderPrompt = {
      clientMessageId: "document-test", delivery: "auto",
      input: { type: "message", content: [
        { type: "text", text: "Edit this document" },
        { type: "uploaded_file", id: "test", fileName: "report.docx", path: source,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: bytes.length },
      ] },
    };
    const result = await files.encode(prompt);
    assert.match(result.nativeText, /report\.docx/);
    assert.ok(result.nativeText.includes(JSON.stringify(source)));
    assert.match(result.nativeText, /--uploaded/);
    assert.match(result.nativeText, /explicitly.*original/i);
    assert.match(result.nativeText, /document_io\.py/);
    assert.equal(result.text, "Edit this document\nAttached file: report.docx");
    await files.close();
    assert.deepEqual(await readFile(source), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("document policy applies to local-path prompts and steering as well", async () => {
  const files = new PromptFiles(runtime);
  const result = await files.encode({ clientMessageId: "steer", delivery: "steer",
    input: { type: "message", content: [{ type: "text", text: `Edit ${path.join(tempRoot, "report.xlsx")}` }] } });
  assert.match(result.nativeText, /openpyxl/);
  assert.match(result.nativeText, /new file/i);
  assert.match(result.nativeText, /--overwrite-original/);
  await files.close();
});

test("missing uploaded files fail before launching the model", async () => {
  const files = new PromptFiles(runtime);
  await assert.rejects(files.encode({ clientMessageId: "missing", delivery: "auto",
    input: { type: "message", content: [{ type: "uploaded_file", id: "missing",
      fileName: "missing.pdf", path: path.join(tempRoot, "no-such-upload-1010.pdf"),
      mimeType: "application/pdf", size: 1 }] } }), /ENOENT/);
});
