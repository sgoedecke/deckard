import subprocess
import sys
import unittest

from profile_instruments import trace_environment, wait_for_recording


class InstrumentsProfileTests(unittest.TestCase):
    def test_environment_does_not_inherit_credentials_or_injection_options(self):
        environment = trace_environment("/Xcode/Developer", {
            "HOME": "/home/example", "LANG": "en_US.UTF-8",
            "API_KEY": "secret", "DYLD_INSERT_LIBRARIES": "/tmp/inject",
            "PATH": "/unsafe/path",
        })
        self.assertEqual(environment, {
            "HOME": "/home/example", "LANG": "en_US.UTF-8",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "DEVELOPER_DIR": "/Xcode/Developer",
        })

    def test_waits_for_recording_marker(self):
        with subprocess.Popen([
            sys.executable, "-c",
            "print('Starting recording\\nCtrl-C to stop the recording', flush=True)"
        ], stdout=subprocess.PIPE) as process:
            self.assertIn(b"Ctrl-C", wait_for_recording(process, timeout=5))

    def test_rejects_exit_before_recording(self):
        with subprocess.Popen([sys.executable, "-c", "print('Failed')"],
                              stdout=subprocess.PIPE) as process:
            with self.assertRaisesRegex(RuntimeError, "before recording"):
                wait_for_recording(process, timeout=5)


if __name__ == "__main__":
    unittest.main()
