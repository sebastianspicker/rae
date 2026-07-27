"""Frozen evaluator-owned expectations for the compile-repair fixture."""

import unittest

from app import format_status


class AppTests(unittest.TestCase):
    def test_formats_ready_status(self) -> None:
        self.assertEqual(format_status("worker-1"), "ready: worker-1")


if __name__ == "__main__":
    unittest.main()
