"""Unit tests for the memory plan and helpers (pure logic, no model, no network). Run: python -m unittest discover -s engine/tests"""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from sevnt_engine import asr_service as A
from sevnt_engine.memory import memory_bytes

GB = 1024 ** 3

class PlanModel(unittest.TestCase):
    def test_enough_ram_keeps_requested_model(self):
        self.assertEqual(A.plan_model("base", 4 * GB, 60), ("base", None))

    def test_low_ram_downgrades_with_note(self):
        model, note = A.plan_model("small", int(0.9 * GB), 60)
        self.assertEqual(model, "tiny" if A.required_free_bytes("base", 60) > 0.9 * GB else "base")
        self.assertIn("tidak cukup", note)

    def test_too_little_ram_for_even_tiny_raises(self):
        with self.assertRaises(A.AsrError) as cm:
            A.plan_model("tiny", int(0.2 * GB), 10)
        self.assertEqual(cm.exception.code, "insufficient_memory")

    def test_memory_need_is_bounded_for_long_audio_because_audio_is_chunked(self):
        # one-pass memory grew ~3.4 GB/hour (measured); with windows the requirement must stop growing after one window
        self.assertEqual(A.required_free_bytes('tiny', 3600), A.required_free_bytes('tiny', 7200))
        self.assertLess(A.required_free_bytes('tiny', 3600), 1 * 1024 ** 3)

    def test_unknown_probe_does_not_block(self):
        self.assertEqual(A.plan_model("small", 0, 100), ("small", None))

    def test_bad_model_rejected(self):
        with self.assertRaises(A.AsrError):
            A.plan_model("large-v3", 8 * GB)

    def test_only_unmeasured_model_is_flagged(self):
        self.assertEqual({m for m, v in A.MEASURED.items() if not v}, {"small"})

class Submit(unittest.TestCase):
    def test_relative_path_rejected(self):
        with self.assertRaises(A.AsrError) as cm:
            A.submit("relative.wav")
        self.assertEqual(cm.exception.code, "bad_path")

    def test_missing_file_rejected(self):
        with self.assertRaises(A.AsrError):
            A.submit(os.path.abspath("definitely-not-here-123.wav"))

class Memory(unittest.TestCase):
    def test_probe_returns_sane_numbers_on_this_os(self):
        total, avail = memory_bytes()
        if sys.platform != "win32":
            self.skipTest("memory probe only verified on Windows in this project")
        self.assertGreater(total, 1 * GB)
        self.assertTrue(0 < avail <= total)

if __name__ == "__main__":
    unittest.main()
