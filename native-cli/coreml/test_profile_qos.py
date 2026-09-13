import io
import unittest
from types import SimpleNamespace

from profile_qos import block_order, set_qos


class QoSProfileTests(unittest.TestCase):
    def test_alternates_orders_and_can_reverse_first_block(self):
        abba = ("baseline", "candidate", "candidate", "baseline")
        baab = ("candidate", "baseline", "baseline", "candidate")
        self.assertEqual([block_order(i, False) for i in range(4)], [abba, baab, abba, baab])
        self.assertEqual([block_order(i, True) for i in range(4)], [baab, abba, baab, abba])

    def test_requires_explicit_control_acknowledgment(self):
        stream = io.StringIO()
        worker = SimpleNamespace(process=SimpleNamespace(stdin=stream),
                                 response=lambda timeout: {"ane_qos": "default"})
        set_qos(worker, "default")
        self.assertEqual(stream.getvalue(), "ane-qos default\n")
        with self.assertRaises(ValueError):
            set_qos(worker, "original")
        with self.assertRaises(ValueError):
            set_qos(worker, "realtime")
        with self.assertRaises(ValueError):
            set_qos(worker, "default", scope="unknown")
        worker.response = lambda timeout: {"public_qos": "original"}
        set_qos(worker, "original", scope="process-thread")
        self.assertTrue(stream.getvalue().endswith("public-qos original\n"))


if __name__ == "__main__":
    unittest.main()
