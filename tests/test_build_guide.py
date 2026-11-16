"""The guide's converter: alerts, dropped links and the left-out section.

    python3 -m unittest tests/test_build_guide.py

Needs markdown-it-py; skipped without it. tests/test_guide_pages.py checks the
published pages themselves and needs nothing.
"""
import importlib.util
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import build_guide as bg  # noqa: E402

HAVE = importlib.util.find_spec("markdown_it") is not None


@unittest.skipUnless(HAVE, "markdown-it-py is not installed")
class Converter(unittest.TestCase):
    def html(self, md, page_dir="docs/guide"):
        import markdown_it
        import markdown_it.token  # noqa: F401
        return bg.render(md, page_dir, markdown_it)

    def test_a_warning_becomes_a_titled_box_with_its_words_kept(self):
        _, body, _ = self.html("# T\n\n> [!WARNING]\n> **Never** do `that`.\n> Second line.\n")
        self.assertIn('<blockquote class="callout callout-warning">', body)
        self.assertIn('<p class="callout-title">Warning</p>', body)
        self.assertIn("<strong>Never</strong> do <code>that</code>.", body)
        self.assertIn("Second line.", body)
        self.assertNotIn("[!WARNING]", body)

    def test_each_kind_has_its_word(self):
        for kind, word in bg.ALERTS.items():
            _, body, _ = self.html("> [!%s]\n> text\n" % kind)
            self.assertIn('callout-%s"' % kind.lower(), body)
            self.assertIn(">%s</p>" % word, body)

    def test_a_marker_elsewhere_stays_text(self):
        _, body, _ = self.html("Prose that says [!WARNING] in passing.\n\n```\n> [!WARNING]\n```\n\n> [!WARNING] is not alone on its line\n> more\n")
        self.assertNotIn("callout", body)
        self.assertEqual(body.count("[!WARNING]"), 3)

    def test_an_ordinary_quote_stays_a_quote(self):
        _, body, _ = self.html("> Just a quote.\n")
        self.assertIn("<blockquote>", body)
        self.assertNotIn("callout", body)

    def test_raw_html_is_not_passed_through(self):
        _, body, _ = self.html("> [!NOTE]\n> <script>x()</script>\n")
        self.assertNotIn("<script>", body)

    def test_links_out_are_dropped_and_their_words_kept(self):
        _, body, dropped = self.html("[the master](../../master/README.md) and [the quickstart](quickstart/README.md#x) and ![p](img/a.png)\n")
        self.assertIn("the master", body)
        self.assertNotIn("master/README.md", body)
        self.assertIn('href="quickstart.html#x"', body)
        self.assertIn('src="img/a.png"', body)
        self.assertEqual(dropped, ["../../master/README.md"])

    def test_links_between_sensor_pages_and_the_guide_land(self):
        _, body, _ = self.html("[guide](../../../../docs/guide/README.md#glossary)\n", "sensors/rf/docs/guide")
        self.assertIn('href="index.html#glossary"', body)

    def test_the_section_for_the_team_and_its_contents_line_are_left_out(self):
        md = "# T\n\n1. [A](#a)\n2. [For people who work on the unit](#for-people-who-work-on-the-unit)\n\n## A\n\nkept\n\n## For people who work on the unit\n\ngone\n"
        _, body, _ = self.html(md)
        self.assertIn("kept", body)
        self.assertNotIn("gone", body)
        self.assertNotIn("For people who work", body)


if __name__ == "__main__":
    unittest.main()
