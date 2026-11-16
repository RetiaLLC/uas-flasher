#!/usr/bin/env python3
"""Turn the unit's user guide into pages of this site.

    build_guide.py fetch --repo OWNER/NAME [--ref COMMIT] --into guide-src
    build_guide.py build --src guide-src --out site/guide

The guide is written in the firmware's repository (docs/guide/), which is
private. `fetch` copies its three pages and its pictures with the `gh` tool.
`build` writes site/guide/index.html, quickstart.html, how-to.html and img/.

What changes on the way, as the guide's owner asked (issue 101 of the firmware's
repository, 15 Nov 2026):

- The full guide's last section, "For people who work on the unit", is left out.
- A link that leaves these pages (into the repository) is dropped and its
  words are kept.
- Links between the pages, to their headings and to the pictures are kept.
- The sensors' own pages are published at the maintainer's word of 16 Nov 2026.
- Nothing else is changed: the words are the owner's.

Needs markdown-it-py (`pip install markdown-it-py`). Raw HTML in the Markdown is
not passed through.
"""
import argparse
import html
import os
import re
import shutil
import subprocess
import sys

PAGES = {  # source, as a path in the firmware's repository -> output name
    "docs/guide/README.md": "index.html",
    "docs/guide/quickstart/README.md": "quickstart.html",
    "docs/guide/how-to/README.md": "how-to.html",
    "sensors/rid/docs/guide/README.md": "remote-id-sensor.html",   # the sensors' owners' pages
    "sensors/rf/docs/guide/README.md": "rf-sensor.html",
}
IMAGES = "docs/guide/img/"
DROP_SECTION = "For people who work on the unit"


def gh_raw(repo, path, ref):
    done = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github.raw",
                           "repos/%s/contents/%s?ref=%s" % (repo, path, ref)], capture_output=True)
    if done.returncode:
        sys.exit("gh: %s: %s" % (path, done.stderr.decode()[-300:]))
    return done.stdout


def cmd_fetch(args):
    import json
    ref = args.ref or json.loads(subprocess.run(["gh", "api", "repos/%s/commits/main" % args.repo],
                                                capture_output=True, check=True).stdout)["sha"]
    tree = json.loads(subprocess.run(["gh", "api", "repos/%s/git/trees/%s?recursive=1" % (args.repo, ref)],
                                     capture_output=True, check=True).stdout)["tree"]
    images = [t["path"] for t in tree if re.match(r"^docs/guide/img/[^/]+\.png$", t["path"])]
    if os.path.isdir(args.into):
        shutil.rmtree(args.into)
    for rel in list(PAGES) + images:
        os.makedirs(os.path.join(args.into, os.path.dirname(rel)), exist_ok=True)
        with open(os.path.join(args.into, rel), "wb") as f:
            f.write(gh_raw(args.repo, rel, ref))
    with open(os.path.join(args.into, "COMMIT"), "w") as f:
        f.write(ref + "\n")
    print("fetched %d pages and %d pictures at %s" % (len(PAGES), len(images), ref[:7]))
    return 0


def slug(text):
    """GitHub's heading anchors: lower case, punctuation out, spaces to hyphens."""
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def drop_section(md, title):
    lines = md.split("\n")
    out, skipping, level = [], False, 0
    for line in lines:
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m and skipping and len(m.group(1)) <= level:
            skipping = False
        if m and m.group(2).strip() == title:
            skipping, level = True, len(m.group(1))
            continue
        if not skipping:
            out.append(line)
    # and its line in the contents
    anchor = "#" + slug(title)
    return "\n".join(l for l in out if not re.match(r"^\s*(\d+\.|-)\s+\[[^\]]*\]\(%s\)\s*$" % re.escape(anchor), l))


def rewrite_target(target, page_dir):
    """Where a link of the guide goes on this site, or None to drop the link and keep its words."""
    if target.startswith(("http://", "https://", "mailto:")):
        return target
    if target.startswith("#"):
        return target
    path, _, anchor = target.partition("#")
    joined = os.path.normpath(os.path.join(page_dir, path)) if path else None
    if joined in PAGES:
        return PAGES[joined] + ("#" + anchor if anchor else "")
    if joined and joined.startswith(IMAGES) and re.match(r"^[^/]+\.png$", joined[len(IMAGES):]):
        return "img/" + joined[len(IMAGES):]
    return None


ALERTS = {"NOTE": "Note", "TIP": "Tip", "IMPORTANT": "Important", "WARNING": "Warning", "CAUTION": "Caution"}
ALERT_MARK = re.compile(r"^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$")


def alerts(tokens, md_lib):
    """GitHub's alerts: a quote whose first line is only [!WARNING] (or NOTE, TIP,
    IMPORTANT, CAUTION) becomes a box with that word as its title. The rest of the
    quote is left as it is. A marker anywhere else, in code or in prose, stays text."""
    Token = md_lib.token.Token
    out, i = [], 0
    while i < len(tokens):
        tok = tokens[i]
        if (tok.type == "blockquote_open" and i + 2 < len(tokens) and tokens[i + 1].type == "paragraph_open"
                and tokens[i + 2].type == "inline" and tokens[i + 2].children
                and tokens[i + 2].children[0].type == "text" and ALERT_MARK.match(tokens[i + 2].children[0].content)):
            kind = ALERT_MARK.match(tokens[i + 2].children[0].content).group(1)
            kids = tokens[i + 2].children[1:]
            if kids and kids[0].type in ("softbreak", "hardbreak"):
                kids = kids[1:]
            tok.attrSet("class", "callout callout-" + kind.lower())
            title = [Token("paragraph_open", "p", 1), Token("inline", "", 0), Token("paragraph_close", "p", -1)]
            title[0].attrSet("class", "callout-title")
            word = Token("text", "", 0)
            word.content = ALERTS[kind]
            title[1].children = [word]
            title[1].content = ALERTS[kind]
            out.append(tok)
            out.extend(title)
            if kids:
                tokens[i + 2].children = kids
                out.extend(tokens[i + 1:i + 3])
                i += 3
            else:
                i += 4          # the paragraph held the marker alone
            continue
        out.append(tok)
        i += 1
    return out


def render(md, page_dir, md_lib):
    md = drop_section(md, DROP_SECTION)
    # Task lists: a box to tick on paper.
    md = re.sub(r"^(\s*)- \[ \] ", "\\1- ☐ ", md, flags=re.M)
    md = re.sub(r"^(\s*)- \[x\] ", "\\1- ☑ ", md, flags=re.M | re.I)
    parser = md_lib.MarkdownIt("commonmark", {"html": False, "typographer": False}).enable("table")
    tokens = alerts(parser.parse(md), md_lib)
    seen = {}
    title = None
    dropped = []
    for i, tok in enumerate(tokens):
        if tok.type == "heading_open":
            text = "".join(c.content for c in tokens[i + 1].children if c.type in ("text", "code_inline"))
            if title is None and tok.tag == "h1":
                title = text
            base = slug(text)
            n = seen.get(base, 0)
            seen[base] = n + 1
            tok.attrSet("id", base if n == 0 else "%s-%d" % (base, n))
        if tok.type == "inline" and tok.children:
            kids, skip_close = [], 0
            for child in tok.children:
                if child.type == "link_open":
                    href = rewrite_target(child.attrGet("href") or "", page_dir)
                    if href is None:
                        dropped.append(child.attrGet("href"))
                        skip_close += 1
                        continue
                    child.attrSet("href", href)
                elif child.type == "link_close" and skip_close:
                    skip_close -= 1
                    continue
                elif child.type == "image":
                    src = rewrite_target(child.attrGet("src") or "", page_dir)
                    if src is None:
                        continue
                    child.attrSet("src", src)
                    child.attrSet("loading", "lazy")
                    child.attrSet("width", "640")
                    child.attrSet("height", "480")
                kids.append(child)
            tok.children = kids
    body = parser.renderer.render(tokens, parser.options, {})
    # Wide tables scroll on their own on a narrow screen.
    body = body.replace("<table>", '<div class="table-scroll"><table>').replace("</table>", "</table></div>")
    return title or "User guide", body, dropped


TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · UAS Detector</title>
<meta name="description" content="{description}">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../vendor/fonts/fonts.css">
<link rel="stylesheet" href="../styles.css">
</head>
<body class="guide-page">
<header class="top wrap">
  <div class="brand">
    <span class="brand-name">UAS DETECTOR</span>
    <span class="brand-what">USER GUIDE</span>
  </div>
  <nav class="guide-nav" aria-label="Guide">
{nav}
    <a href="../">Firmware</a>
  </nav>
</header>
<main class="wrap guide">
<p class="guide-note">{note}</p>
{body}
</main>
<footer class="wrap foot">
  <p>The detector only listens for aircraft and their controllers. Its sensors never transmit, and the master's one radio link is Bluetooth to a phone.</p>
  <p class="foot-small">From the project's guide at commit {commit}.</p>
</footer>
</body>
</html>
"""

NOTE_UNIT = ("The Anubis 1.0 release on the <a href=\"../\">firmware page</a> has the landscape screen shown "
             "here. Bastet 0.9 has a portrait screen. Commands that start with <code>python3 tools/</code> need the "
             "project's tools, which aren't publicly available.")
NOTE_SENSOR = ("The team that builds this sensor wrote this page. The issues, pull requests and records that it names are in "
               "the project's own repository, which isn't public. The <a href=\"../\">firmware page</a> can flash the "
               "Remote ID sensor in a browser. It can't flash the RF sensor, because no release has the RF sensor's files.")

NAV = [("index.html", "Guide"), ("quickstart.html", "Quickstart"), ("how-to.html", "How-to"),
       ("remote-id-sensor.html", "Remote ID sensor"), ("rf-sensor.html", "RF sensor")]


def cmd_build(args):
    import markdown_it
    import markdown_it.token  # noqa: F401  (for alerts)
    commit = open(os.path.join(args.src, "COMMIT")).read().strip()[:7] if os.path.exists(os.path.join(args.src, "COMMIT")) else "unknown"
    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(os.path.join(args.out, "img"))
    used_images = set()
    for src, name in PAGES.items():
        with open(os.path.join(args.src, src), encoding="utf-8") as f:
            md = f.read()
        title, body, dropped = render(md, os.path.dirname(src), markdown_it)
        used_images.update(re.findall(r'src="img/([^"]+\.png)"', body))
        first_para = re.search(r"<p>(.*?)</p>", body, re.S)
        description = re.sub(r"<[^>]+>", "", first_para.group(1)) if first_para else title
        nav = "\n".join('    <a href="%s"%s>%s</a>' % (href, ' aria-current="page"' if href == name else "", label) for href, label in NAV)
        note = (NOTE_SENSOR if src.startswith("sensors/") else NOTE_UNIT)
        page = TEMPLATE.format(title=html.escape(title), description=html.escape(description[:200], quote=True),
                               nav=nav, body=body, commit=html.escape(commit), note=note)
        with open(os.path.join(args.out, name), "w", encoding="utf-8") as f:
            f.write(page)
        print("%s -> %s: %d bytes, %d links dropped%s" % (src, name, len(page), len(dropped),
              " (" + ", ".join(sorted(set(dropped))) + ")" if dropped else ""))
    missing = [i for i in used_images if not os.path.exists(os.path.join(args.src, IMAGES, i))]
    for img in sorted(set(used_images) - set(missing)):
        shutil.copyfile(os.path.join(args.src, IMAGES, img), os.path.join(args.out, "img", img))
    print("%d pictures copied%s" % (len(used_images), "; missing: " + ", ".join(missing) if missing else ""))
    return 1 if missing else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--repo", required=True)
    f.add_argument("--ref")
    f.add_argument("--into", required=True)
    f.set_defaults(fn=cmd_fetch)
    b = sub.add_parser("build")
    b.add_argument("--src", required=True)
    b.add_argument("--out", required=True)
    b.set_defaults(fn=cmd_build)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
