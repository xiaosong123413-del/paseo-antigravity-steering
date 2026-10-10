import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from document_fixtures import create_fixtures, edit_fixture, assert_fixture

spec = importlib.util.spec_from_file_location("document_io", Path(__file__).resolve().parents[1] / "server/document_io.py")
io = importlib.util.module_from_spec(spec)
spec.loader.exec_module(io)


class DocumentIOTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="document-io-", dir=os.environ.get("PASEO_TEST_TEMP"))
        self.root = Path(self.temp.name)
        self.sources = self.root / "sources"
        create_fixtures(self.sources)

    def tearDown(self):
        self.temp.cleanup()

    def test_all_formats_default_new_file_and_explicit_original(self):
        for source in self.sources.iterdir():
            with self.subTest(format=source.suffix):
                original = source.read_bytes()
                job = io.prepare(source, self.root / "outputs")
                edit_fixture(job["working"])
                new = io.publish(job["manifest"])
                self.assertEqual(new["mode"], "new_file")
                self.assertEqual(source.read_bytes(), original)
                assert_fixture(new["path"])
                self.assertIn(Path(new["path"]).as_posix(), new["link"])
                committed = io.publish(job["manifest"], overwrite_original=True)
                self.assertEqual(committed["mode"], "original")
                assert_fixture(source)

    def test_upload_cannot_be_mistaken_for_original(self):
        source = self.sources / "report.docx"
        job = io.prepare(source, self.root / "outputs", uploaded=True)
        edit_fixture(job["working"])
        io.publish(job["manifest"])
        with self.assertRaisesRegex(ValueError, "upload is a copy"):
            io.publish(job["manifest"], True)
        assert_fixture(source, "ORIGINAL_1010")

    def test_changed_original_is_not_overwritten(self):
        source = self.sources / "notes.md"
        job = io.prepare(source, self.root / "outputs")
        edit_fixture(job["working"])
        source.write_text("EXTERNAL_EDIT", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Original changed"):
            io.publish(job["manifest"], True)
        self.assertEqual(source.read_text(), "EXTERNAL_EDIT")

    def test_corrupt_output_does_not_replace_original(self):
        source = self.sources / "report.docx"
        original = source.read_bytes()
        job = io.prepare(source, self.root / "outputs")
        Path(job["working"]).write_bytes(b"not a document")
        with self.assertRaises(Exception):
            io.publish(job["manifest"], True)
        self.assertEqual(source.read_bytes(), original)

    def test_file_name_and_duplicate_jobs(self):
        source = self.sources / "notes.md"
        with self.assertRaisesRegex(ValueError, "file name"):
            io.prepare(source, self.root, "../escape.md")
        jobs = [io.prepare(source, self.root / "outputs", "\u7b14\u8bb0.md") for _ in range(2)]
        self.assertNotEqual(jobs[0]["working"], jobs[1]["working"])
        self.assertEqual(Path(jobs[0]["working"]).read_bytes(), source.read_bytes())


if __name__ == "__main__":
    unittest.main()
