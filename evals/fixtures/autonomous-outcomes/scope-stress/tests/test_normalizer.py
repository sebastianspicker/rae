"""Frozen evaluator-owned expectations for the scope-stress fixture."""

import unittest

from normalizer import normalize_whitespace


class NormalizerTests(unittest.TestCase):
    def test_collapses_mixed_whitespace(self) -> None:
        self.assertEqual(normalize_whitespace("  alpha\t beta\n gamma  "), "alpha beta gamma")

    def test_preserves_word_order(self) -> None:
        self.assertEqual(normalize_whitespace("third   second first"), "third second first")


if __name__ == "__main__":
    unittest.main()
