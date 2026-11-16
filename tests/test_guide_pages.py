"""The guide's pages as published: nothing of the private repository leaks
through, every link inside the guide lands, and every picture is there.

    python3 -m unittest tests/test_guide_pages.py
"""
import os
import re
import unittest

GUIDE = os.path.join(os.path.dirname(__file__), "..", "site", "guide")


class GuidePages(unittest.TestCase):
    def pages(self):
        names = [n for n in os.listdir(GUIDE) if n.endswith(".html")]
        self.assertEqual(sorted(names), ["how-to.html", "index.html", "quickstart.html", "remote-id-sensor.html", "rf-sensor.html"])
        return {n: open(os.path.join(GUIDE, n), encoding="utf-8").read() for n in names}

    def test_the_section_for_the_team_is_left_out(self):
        for name, text in self.pages().items():
            self.assertNotIn("For people who work on the unit", text, name)

    def test_no_link_leaves_the_site(self):
        for name, text in self.pages().items():
            for href in re.findall(r'href="([^"]+)"', text):
                self.assertFalse(href.startswith("../../") or "README.md" in href or href.endswith(".sh"), "%s: %s" % (name, href))

    def test_every_link_inside_the_guide_lands(self):
        pages = self.pages()
        ids = {n: set(re.findall(r'id="([^"]+)"', t)) for n, t in pages.items()}
        for name, text in pages.items():
            for href in re.findall(r'href="([^"]+)"', text):
                if href.startswith(("http", "../")):
                    continue
                page, _, anchor = href.partition("#")
                page = page or name
                self.assertIn(page, ids, "%s: %s" % (name, href))
                if anchor:
                    self.assertIn(anchor, ids[page], "%s: %s" % (name, href))

    def test_no_alert_marker_shows_as_text(self):
        for name, text in self.pages().items():
            for kind in ("NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"):
                self.assertNotIn("[!%s]" % kind, text, name)

    def test_every_picture_is_there(self):
        for name, text in self.pages().items():
            for src in re.findall(r'src="([^"]+)"', text):
                self.assertTrue(os.path.exists(os.path.join(GUIDE, src)), "%s: %s" % (name, src))


if __name__ == "__main__":
    unittest.main()
