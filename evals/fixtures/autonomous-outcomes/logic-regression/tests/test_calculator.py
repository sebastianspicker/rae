"""Frozen evaluator-owned expectations for the held-out calculator fixture."""

import unittest

from calculator import add


class CalculatorTests(unittest.TestCase):
    def test_adds_positive_values(self) -> None:
        self.assertEqual(add(2, 3), 5)

    def test_adds_negative_values(self) -> None:
        self.assertEqual(add(-4, -3), -7)


if __name__ == "__main__":
    unittest.main()
