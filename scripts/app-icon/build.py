"""
重新生成应用图标全套资源（依赖 rsvg-convert：brew install librsvg）。

    python3 scripts/app-icon/build.py

emblem.py 按参数画出图案（两个交扣的折带 V 形），本脚本把它包进不同底板：
  - public/logo-mark.svg        透明底纯图案：界面内 logo
  - public/favicon.svg / .png   白色圆角底板：浏览器标签
  - public/logo-{1024..128}.png macOS 规格（824 底板 + 留白 + 投影）：安装包 / 通知
  - public/icons/*.png          方形白底：PWA / iOS（系统自己加遮罩）
"""
import json, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')

# 定稿参数：尖端→末端由粗到细、边长缩 1/4、两个 V 各靠拢 40px
PARAMS = {'vertex_scale': 1.15, 'end_scale': 0.55, 'arm_scale': 0.75, 'close': 40, 'fit': 1000, 'transparent': True}


def emblem_body():
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'emblem.svg')
        subprocess.run([sys.executable, os.path.join(HERE, 'emblem.py'), out, json.dumps(PARAMS)], check=True)
        svg = open(out).read()
    return re.search(r'<svg[^>]*>(.*)</svg>', svg, re.S).group(1)


def wrap(body, size, tile=None, emblem_box=1024, offset=0, shadow=False):
    """把 1024 画布的图案缩放到 emblem_box 并居中；tile=(x, y, w, rx) 画白色圆角底板。"""
    s = emblem_box / 1024
    tx = (size - emblem_box) / 2 + offset
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">']
    if tile:
        x, y, w, rx = tile
        if shadow:
            parts.append('<defs><filter id="ts" x="-10%" y="-10%" width="120%" height="130%">'
                         '<feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0b1b4d" flood-opacity="0.28"/></filter></defs>')
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{w}" rx="{rx}" fill="#ffffff"{" filter=\"url(#ts)\"" if shadow else ""}/>')
    parts.append(f'<g transform="translate({tx:.1f} {tx:.1f}) scale({s:.4f})">{body}</g></svg>')
    return ''.join(parts)


def render(svg_text, png_path, px):
    with tempfile.NamedTemporaryFile('w', suffix='.svg', delete=False) as f:
        f.write(svg_text)
    subprocess.run(['rsvg-convert', '-w', str(px), '-h', str(px), f.name, '-o', png_path], check=True)
    os.unlink(f.name)


def main():
    body = emblem_body()
    # gradient / filter id 在多份内联时不冲突（每个文件只内联一次）
    mark = wrap(body, 1024)
    open(os.path.join(PUBLIC, 'logo-mark.svg'), 'w').write(mark)

    rounded = wrap(body, 1024, tile=(0, 0, 1024, 229), emblem_box=760)
    open(os.path.join(PUBLIC, 'favicon.svg'), 'w').write(rounded)
    render(rounded, os.path.join(PUBLIC, 'favicon.png'), 64)

    # macOS：1024 画布中 824 底板居中，圆角约 22.37%，图案占底板约 76%
    app = wrap(body, 1024, tile=(100, 100, 824, 184), emblem_box=630, shadow=True)
    for px in (1024, 512, 256, 128):
        render(app, os.path.join(PUBLIC, f'logo-{px}.png'), px)

    square = wrap(body, 1024, tile=(0, 0, 1024, 0), emblem_box=720)
    for px in (72, 96, 128, 144, 152, 192, 384, 512):
        render(square, os.path.join(PUBLIC, 'icons', f'icon-{px}x{px}.png'), px)
    render(square, os.path.join(PUBLIC, 'icons', 'apple-touch-icon.png'), 180)
    print('icons written to', PUBLIC)


if __name__ == '__main__':
    main()
