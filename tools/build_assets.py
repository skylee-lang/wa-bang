"""
와방 페이지 속도용 빌드 도구
 - Tailwind: 손님 휴대폰에서 매번 돌리던 Tailwind CDN(약 400KB, 실행 시 CSS 생성) 대신
   페이지에서 실제로 쓰는 클래스만 미리 만들어 <style id="tw-build"> 로 넣음
 - 아이콘: Phosphor 아이콘 4종 전체 글꼴(약 900KB) 대신 쓰는 아이콘만 잘라 <style id="icon-build"> 로 넣음

사용법 (원본은 *.src.html, 결과는 index.html):
  python3 tools/build_assets.py index.src.html index.html
  python3 tools/build_assets.py chat/index.src.html chat/index.html
필요: playwright + 크롬, fontTools, Tailwind Play CDN 파일(TW_JS), Phosphor 원본(PH_DIR)
※ 원본(*.src.html)을 고친 뒤에는 반드시 이 도구를 다시 돌려야 새 클래스·아이콘이 반영돼요.
"""
import sys, re, base64, io, asyncio, os
from fontTools import subset
from fontTools.ttLib import TTFont

TW_JS = os.environ.get("TW_JS", "/opt/npm-tools/node_modules/@zenuml/core/dist/vendor/tailwindcss/tailwindcss.js")
PH_DIR = os.environ.get("PH_DIR", "/tmp/phweb/web/src")
WEIGHTS = {"ph": ("regular", "Phosphor"), "ph-bold": ("bold", "Phosphor-Bold"),
           "ph-fill": ("fill", "Phosphor-Fill"), "ph-duotone": ("duotone", "Phosphor-Duotone")}

TW_TAG = re.compile(r'<script src="https://cdn\.tailwindcss\.com[^"]*"></script>\s*')
PH_TAGS = re.compile(r'\s*<(?:script src|link rel="stylesheet" href)="https://unpkg\.com/@phosphor-icons/web[^"]*"(?: /)?>(?:</script>)?')

def icon_css(html):
    names = set(re.findall(r'ph-([a-z0-9]+(?:-[a-z0-9]+)*)', html)) - {"fill", "bold", "duotone", "light", "thin"}
    used_w = [w for w in WEIGHTS if (re.search(r'["\'\s`]ph[\s"\']', html) if w == "ph" else (w in html))]
    out = []
    for w in used_w:
        folder, fam = WEIGHTS[w]
        css = open(f"{PH_DIR}/{folder}/style.css", encoding="utf-8").read()
        head = css.split("}", 2)  # @font-face{...} 다음 기본 클래스 블록
        base_rule = "}".join(head[1:2]) + "}"
        rules, cps = [], set()
        for n in sorted(names):
            for m in re.finditer(r'\.%s\.ph-%s:(before|after)\s*\{[^}]*\}' % (re.escape(w), re.escape(n)), css):
                rules.append(re.sub(r'\s+', ' ', m.group(0)))
                cps.update(int(c, 16) for c in re.findall(r'content:\s*"\\([0-9a-f]+)"', m.group(0)))
        if not cps: continue
        font = TTFont(f"{PH_DIR}/{folder}/{fam}.ttf")
        opt = subset.Options(); opt.flavor = "woff"; opt.layout_features = ["*"]; opt.name_IDs = ["*"]
        sub = subset.Subsetter(opt); sub.populate(unicodes=cps); sub.subset(font)
        # 원본 글꼴은 hmtx 왼쪽 여백(lsb)이 0으로 적혀 있어서, 잘라낸 글꼴에서 아이콘이 왼쪽으로 쏠려 보임
        # → 각 아이콘의 실제 왼쪽 끝(xMin)으로 맞춰서 원래 위치(가운데)에 그려지게 함
        glyf, hmtx = font["glyf"], font["hmtx"]
        for gname in font.getGlyphOrder():
            g = glyf[gname]
            if g.numberOfContours:
                g.recalcBounds(glyf); adv, _ = hmtx[gname]; hmtx[gname] = (adv, g.xMin)
        buf = io.BytesIO(); font.flavor = "woff"; font.save(buf)
        data = base64.b64encode(buf.getvalue()).decode()
        out.append('@font-face{font-family:"%s";src:url(data:font/woff;base64,%s) format("woff");font-weight:normal;font-style:normal;font-display:block}' % (fam, data))
        out.append(re.sub(r'/\*.*?\*/', '', re.sub(r'\s+', ' ', base_rule)).strip())
        out.extend(rules)
    return "\n".join(out)

async def tw_css(html):
    from playwright.async_api import async_playwright
    tokens = set(re.findall(r'[A-Za-z0-9!:\-\[\]\/#.%()_,&>~*@+=]+', re.sub(r'[`\'"<>{}$;]', ' ', html)))
    tokens = [t for t in tokens if any(c.isalpha() for c in t) and len(t) < 80]
    probe = '<div id="__tw_probe" hidden class="%s"></div>' % " ".join(tokens).replace('"', '')
    page_html = html.replace("</body>", probe + "</body>")
    tw = open(TW_JS, encoding="utf-8").read()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = await b.new_page()
        async def h(route):
            u = route.request.url
            if "cdn.tailwindcss.com" in u: await route.fulfill(body=tw, content_type="application/javascript")
            elif u.startswith("http://wabang.local/"): await route.fulfill(body=page_html, content_type="text/html")
            else: await route.abort()
        await pg.route("**/*", h)
        await pg.goto("http://wabang.local/")
        await pg.wait_for_timeout(1500)
        css = await pg.evaluate('[...document.querySelectorAll("style")].map(s=>s.textContent).find(t=>/tailwindcss v3/.test(t))||""')
        await b.close()
    if not css: raise SystemExit("Tailwind CSS를 못 만들었어요")
    css = re.sub(r'/\*(?!! tailwindcss).*?\*/', '', css, flags=re.S)
    return re.sub(r'\s*\n\s*', '\n', css).strip()

def build(src, dst):
    html = open(src, encoding="utf-8").read()
    tw = asyncio.run(tw_css(html))
    icons = icon_css(html)
    out = TW_TAG.sub("", html)
    out = PH_TAGS.sub("", out)
    # tailwind.config 는 CDN 전용 설정이라 빌드본에서는 실행 안 되게 (window.tailwind 없으면 건너뜀)
    out = out.replace("tailwind.config={", "if(window.tailwind)tailwind.config={", 1)
    note = "<!-- ⚠ 이 파일은 tools/build_assets.py 로 만든 빌드본이에요. 고칠 때는 %s 를 고치고 다시 빌드하세요. -->\n" % os.path.basename(src)
    block = '<style id="icon-build">%s</style>\n<style id="tw-build">%s</style>\n' % (icons, tw)
    out = out.replace("</head>", block + "</head>", 1)
    out = out.replace("<head>", "<head>\n" + note, 1)
    open(dst, "w", encoding="utf-8").write(out)
    print(dst, "tailwind", len(tw)//1024, "KB / icons", len(icons)//1024, "KB / total", len(out)//1024, "KB")

if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
