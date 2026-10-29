"""Exercise short sealed-value redaction through the real helper and supervisor pipeline.

The watcher is faked at its module boundary; the actual agent_browser_mask redactor and the
production jev_redact/supervisor functions run. Run: python3 packages/sandbox-image/local/jev_security_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = os.path.normpath(os.path.join(HERE, "..", "files"))
JEV = os.path.join(FILES, "jev-browser")


class ShortSealedValueTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fake = self.temp.name
        with open(os.path.join(self.fake, "agent_browser_watch.py"), "w", encoding="utf-8") as handle:
            handle.write(
                "def ensure_watcher(port, deadline):\n"
                "    return True\n"
                "def ask_watcher(port, request, timeout):\n"
                "    return {'ok': True, 'values': ['7', '4821']}\n"
            )
        self.env = dict(os.environ)
        self.env["PYTHONPATH"] = self.fake + os.pathsep + FILES

    def tearDown(self):
        self.temp.cleanup()

    def test_structured_snapshot_masks_short_value_without_moving_refs(self):
        page = {
            "elements": [
                {"i": 7, "tag": "input:text", "value": "7", "label": "PIN"},
                {"i": 3, "tag": "input:text", "text": "secret 4821"},
            ]
        }
        run = subprocess.run(
            [sys.executable, os.path.join(JEV, "jev_redact.py"), "9223"],
            input=json.dumps(page), text=True, capture_output=True, env=self.env, check=False,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        redacted = json.loads(run.stdout)
        self.assertEqual(redacted["elements"][0], {"i": 7, "tag": "input:text", "value": "••••", "label": "PIN"})
        self.assertEqual(redacted["elements"][1]["i"], 3)
        self.assertEqual(redacted["elements"][1]["text"], "secret ••••")
        self.assertNotIn('"value": "7"', run.stdout)

    def test_native_state_json_is_parsed_before_recursive_redaction(self):
        sys.path.insert(0, FILES)
        sys.path.insert(0, JEV)
        sys.path.insert(0, self.fake)
        try:
            from agent_jev_supervise import redact_native_value
        finally:
            sys.path.remove(FILES)
            sys.path.remove(JEV)
            sys.path.remove(self.fake)
        redacted = redact_native_value(9223, '{"pin":"7","note":"4821"}')
        self.assertEqual(json.loads(redacted), {"pin": "••••", "note": "••••"})


if __name__ == "__main__":
    unittest.main()
