"""The phone app on the page: every APK the page links to exists, and its SHA-256 on the page is the file's."""
import hashlib
import os
import re
import unittest

SITE = os.path.join(os.path.dirname(__file__), "..", "site")


class AppDownload(unittest.TestCase):
    def test_each_linked_apk_exists_and_its_sum_is_right(self):
        page = open(os.path.join(SITE, "index.html"), encoding="utf-8").read()
        links = re.findall(r'href="(app/[^"]+\.apk)"', page)
        self.assertTrue(links, "the page links to no APK")
        sums = re.findall(r"SHA-256 ([0-9a-f]{64})", page)
        for link in links:
            data = open(os.path.join(SITE, link), "rb").read()
            self.assertIn(hashlib.sha256(data).hexdigest(), sums, link)
            self.assertIn("%.1f MB" % (len(data) / 1048576), page, link)


if __name__ == "__main__":
    unittest.main()
