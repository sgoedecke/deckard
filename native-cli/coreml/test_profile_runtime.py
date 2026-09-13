import unittest

from profile_runtime import cpu_summary, main_thread_samples


class RuntimeProfileTests(unittest.TestCase):
    def test_counts_main_thread_only_without_counting_nested_ane_frames_twice(self):
        text = """Call graph:
    100 Thread_1: Main Thread   DispatchQueue_main
    + 100 main
    +   90 EvaluateANERequest()
    +     90 -[_ANEClient doEvaluateDirectWithModel:options:]
    +       90 mach_msg2_trap
    +   5 Espresso::ANERuntimeEngine::blob_container::__copy_from_host()
    +   5 Espresso::tile_kernel_cpu::__launch()
    100 Thread_2: Worker
    + 100 EvaluateANERequest()
Total number in stack:
"""
        result = main_thread_samples(text)
        self.assertEqual(result["main_thread_samples"], 100)
        self.assertEqual(result["counts"]["ane_request_path"], 90)
        self.assertEqual(result["fractions"]["host_to_ane_copy"], 0.05)
        self.assertEqual(result["counts"]["cpu_tile"], 5)
        dispatch_label = text.replace(": Main Thread   DispatchQueue_main",
                                      "   DispatchQueue_1: com.apple.main-thread  (serial)")
        self.assertEqual(main_thread_samples(dispatch_label), result)
        coreml_label = text.replace(": Main Thread   DispatchQueue_main",
                                    "   DispatchQueue_56: com.apple.CoreMLBatchProcessingQueue  (serial)")
        coreml_label = coreml_label.replace("+ 100 main", "+ 100 main  (in deckard-coreml)")
        self.assertEqual(main_thread_samples(coreml_label), result)

    def test_rejects_unrecognized_sampling_reports(self):
        for text in ("", "    100 Thread_1: Main Thread\n"):
            with self.assertRaises(ValueError):
                main_thread_samples(text)

    def test_cpu_time_is_not_mislabeled_as_hardware_busy_time(self):
        result = cpu_summary({"process_cpu_seconds": 0.2, "begin": 10, "end": 12, "requests": 4})
        self.assertEqual(result["process_cpu_ms_per_request"], 50)
        self.assertEqual(result["wall_ms_per_request"], 500)
        self.assertEqual(result["process_cpu_seconds_per_wall_second"], 0.1)
        with self.assertRaises(ValueError):
            cpu_summary({"process_cpu_seconds": -1, "begin": 10, "end": 12, "requests": 4})


if __name__ == "__main__":
    unittest.main()
