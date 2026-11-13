import unittest
from eval.analyze import metrics, safe_div

class MetricTests(unittest.TestCase):
    def test_hand_computed_precision_recall_f1(self):
        result = metrics({"tp": 3, "fp": 1, "fn": 2})
        self.assertEqual(result["precision"], 0.75)
        self.assertEqual(result["recall"], 0.6)
        self.assertAlmostEqual(result["f1"], 2 * 0.75 * 0.6 / 1.35)

    def test_clean_false_positive_rate(self):
        self.assertEqual(safe_div(3, 2), 1.5)
        self.assertIsNone(safe_div(0, 0))

if __name__ == "__main__":
    unittest.main()
