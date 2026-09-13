from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from report_instruments import correlate, prediction_intervals, request_spans, table_rows


def event(timestamp, code, pid=123):
    fields = {}
    for name, value in (("time", timestamp), ("class", 43), ("subclass", 36),
                        ("code", code), ("arg2", 456)):
        fields[name] = ET.Element(name)
        fields[name].text = str(value)
    fields["thread"] = ET.Element("thread", fmt=f"Main Thread (example, pid: {pid})")
    return fields


class InstrumentsReportTests(unittest.TestCase):
    def test_resolves_trace_references_and_uses_schema_column_names(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.xml"
            path.write_text("""<trace-query-result><node><schema>
                <col><mnemonic>start</mnemonic></col><col><mnemonic>duration</mnemonic></col>
                </schema><row><start-time id="1">100</start-time><duration id="2">20</duration></row>
                <row><start-time id="3">200</start-time><duration ref="2"/></row>
                </node></trace-query-result>""")
            rows = table_rows(path)
        self.assertEqual(rows[1]["start"].text, "200")
        self.assertEqual(rows[1]["duration"].text, "20")

    def test_attributes_only_target_markers_and_reports_foreign_requests(self):
        spans, foreign = request_spans([
            event(10, 50), event(20, 51), event(30, 50, pid=456), event(40, 51, pid=456),
        ], 123)
        self.assertEqual(spans, [(10, 20)])
        self.assertEqual(foreign, 1)
        for rows in ([event(10, 50)], [event(20, 51)], [event(10, 50), event(11, 50)]):
            with self.assertRaises(ValueError):
                request_spans(rows, 123)

    def test_correlates_hardware_intervals_without_calling_lead_time_compute(self):
        result = correlate([(12, 18), (32, 38)], [(10, 20), (30, 40)])
        self.assertEqual(result[0], {
            "start_ns": 12, "end_ns": 18, "duration_ns": 6,
            "marker_lead_ns": 2, "marker_tail_ns": 2,
        })
        for intervals, spans in (
            ([], [(10, 20)]),
            ([(12, 14), (16, 18)], [(10, 20)]),
            ([(12, 18)], [(10, 20), (11, 21)]),
        ):
            with self.assertRaises(ValueError):
                correlate(intervals, spans)

    def test_does_not_count_overlapping_load_activity_as_prediction_time(self):
        rows = []
        for label, start, duration in (
            ("Neural Engine Prediction", 10, 20),
            ("Neural Engine Load: prepare and cache", 5, 100),
        ):
            row = {"event-label": ET.Element("formatted-label", fmt=label)}
            for key, value in (("start", start), ("duration", duration)):
                row[key] = ET.Element(key)
                row[key].text = str(value)
            rows.append(row)
        intervals, other = prediction_intervals(rows)
        self.assertEqual(intervals, [(10, 30)])
        self.assertEqual(other, {"Neural Engine Load: prepare and cache": 1})


if __name__ == "__main__":
    unittest.main()
