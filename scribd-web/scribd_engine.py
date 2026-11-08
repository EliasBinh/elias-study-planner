import os
import re
import json
import gzip
import base64
import urllib.request
import subprocess

import shutil

def find_chrome():
    if os.name == 'nt':
        candidates = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            os.path.expanduser(r"~\AppData\Local\Google\Chrome\Application\chrome.exe")
        ]
        for c in candidates:
            if os.path.exists(c):
                return c
        return "chrome.exe"
    else:
        for c in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]:
            p = shutil.which(c)
            if p:
                return p
        return "google-chrome"

CHROME_PATH = find_chrome()
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

def clean_filename(title):
    cleaned = re.sub(r'[\\/*?:"<>|]', '', title).strip()
    return cleaned[:100] or "scribd_document"

def scale_style_values(style_val, factor=0.2):
    def repl_px(match):
        val = float(match.group(1))
        new_val = round(val * factor, 2)
        if new_val == int(new_val):
            new_val = int(new_val)
        return f"{new_val}px"
    return re.sub(r'(-?\d+(?:\.\d+)?)px', repl_px, style_val)

def process_page_html(raw_html, images_base64):
    def repl_text_layer(match):
        tl_content = match.group(0)
        def repl_style_attr(sm):
            return f'style="{scale_style_values(sm.group(1))}"'
        return re.sub(r'style="([^"]*)"', repl_style_attr, tl_content)

    content = re.sub(r'<div class=text_layer[^>]*>.*?</div>\s*</div>\s*</div>', repl_text_layer, raw_html, flags=re.DOTALL)

    def repl_img(match):
        img_name = match.group(1)
        if img_name in images_base64:
            return f'src="data:image/jpeg;base64,{images_base64[img_name]}"'
        return match.group(0)

    content = re.sub(r'orig=["\']https?://[^"\']+/images/([^"\']+)["\']', repl_img, content)
    return content

def fetch_url(url):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    return data

def convert_scribd_url_to_pdf(url, output_dir, progress_cb=None):
    os.makedirs(output_dir, exist_ok=True)

    if progress_cb: progress_cb("Đang kết nối và lấy thông tin tài liệu...", 10)

    # Clean URL
    target_url = url.split('?')[0].strip()

    raw_html = fetch_url(target_url)
    html = raw_html.decode('utf-8', errors='ignore')

    # Extract Document Title
    title = "Scribd Document"
    title_m = re.search(r'<title>(.*?)</title>', html, re.I)
    if title_m:
        title = title_m.group(1).replace(" | PDF", "").replace(" | Scribd", "").strip()

    # Look for pages with contentUrl
    page_matches = re.findall(r'pageNum:\s*(\d+).*?contentUrl:\s*["\']([^"\']+)["\']', html, re.DOTALL)
    if not page_matches:
        # Fallback: find all jsonp urls
        jsonp_urls = sorted(list(set(re.findall(r'https?://[^\s"\'<>]+\.jsonp', html))))
        if jsonp_urls:
            page_matches = [(i+1, u) for i, u in enumerate(jsonp_urls)]

    if not page_matches:
        raise ValueError("Không tìm thấy các trang tài liệu. Tài liệu này có thể yêu cầu tài khoản Scribd hoặc bị giới hạn quyền xem trước.")

    if progress_cb: progress_cb(f"Đã tìm thấy tài liệu: {title[:50]}...", 25)

    # Extract fonts and asset prefix
    font_matches = re.findall(r'docManager\.addFont\(\s*(\d+)', html)
    asset_prefix_m = re.search(r'docManager\.assetPrefix\s*=\s*["\']([^"\']+)["\']', html)
    asset_prefix = asset_prefix_m.group(1) if asset_prefix_m else None
    
    if not asset_prefix and page_matches:
        m = re.search(r'html\.scribdassets\.com/([^/]+)/', page_matches[0][1])
        if m: asset_prefix = m.group(1)

    # Download fonts
    fonts_base64 = {}
    if asset_prefix:
        font_ids = [int(f) for f in set(font_matches)] if font_matches else [0, 1, 2, 3]
        for fid in font_ids:
            fname = f"{fid:04d}.woff2"
            font_url = f"https://html.scribdassets.com/{asset_prefix}/fonts/{fname}"
            try:
                raw_font = fetch_url(font_url)
                if raw_font.startswith(b'\x1f\x8b'):
                    raw_font = gzip.decompress(raw_font)
                fonts_base64[fid] = base64.b64encode(raw_font).decode('ascii')
            except Exception as e:
                print(f"Font download error {fname}: {e}")

    # Build font CSS
    font_faces_css = []
    font_class_css = []
    for fid, b64 in fonts_base64.items():
        weight = "bold" if fid in [0, 3] else "normal"
        font_faces_css.append(f"""
        @font-face {{
            font-family: 'ff{fid}';
            src: url(data:application/font-woff2;charset=utf-8;base64,{b64}) format('woff2');
            font-weight: {weight};
            font-style: normal;
        }}
        """)
        font_class_css.append(f"div.ff{fid} span {{ font-family: 'ff{fid}', 'Times New Roman', serif; font-weight: {weight}; }}")

    # Download pages
    total_pages = len(page_matches)
    pages_html_list = []
    images_base64 = {}

    for idx, (p_num, content_url) in enumerate(page_matches):
        p_pct = int(30 + (idx / total_pages) * 45)
        if progress_cb: progress_cb(f"Đang tải trang {idx+1}/{total_pages}...", p_pct)
        try:
            p_bytes = fetch_url(content_url)
            if p_bytes.startswith(b'\x1f\x8b'):
                p_text = gzip.decompress(p_bytes).decode('utf-8', errors='ignore')
            else:
                p_text = p_bytes.decode('utf-8', errors='ignore')

            cb_m = re.search(r'window\.page\d+_callback\((.*)\);', p_text, re.DOTALL)
            if cb_m:
                page_content = json.loads(cb_m.group(1))[0]
            else:
                page_content = p_text

            # Download background images for this page
            orig_images = re.findall(r'orig=["\'](https?://[^"\']+/images/([^"\']+))["\']', page_content)
            for img_url, img_name in orig_images:
                if img_name not in images_base64:
                    try:
                        dl_img_url = img_url.replace("http://html.scribd.com", "https://html.scribdassets.com")
                        raw_img = fetch_url(dl_img_url)
                        images_base64[img_name] = base64.b64encode(raw_img).decode('ascii')
                    except Exception:
                        pass

            # Skip empty pages
            stripped = re.sub(r'<[^>]+>', '', page_content).strip()
            if not stripped and 'img' not in page_content:
                continue

            processed_content = process_page_html(page_content, images_base64)
            pages_html_list.append(f"""
            <div class="page-wrapper">
                <div class="outer_page" id="outer_page_{p_num}">
                    {processed_content}
                </div>
            </div>
            """)
        except Exception as e:
            print(f"Error processing page {p_num}: {e}")

    if not pages_html_list:
        raise ValueError("Không thể trích xuất nội dung các trang tài liệu.")

    if progress_cb: progress_cb("Đang tổng hợp bố cục và font chữ vector...", 80)

    w_css = "\n".join([f".text_layer span.w{n} {{ width: {round(n * 0.2, 2)}px; }}" for n in range(1, 13)])
    l_css = "\n".join([f".text_layer span.l{n} {{ margin: 0 0 0 -{round(n * 0.2, 2)}px; }}" for n in range(1, 13)])

    compiled_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
{''.join(font_faces_css)}
{''.join(font_class_css)}

* {{ box-sizing: border-box; }}

@page {{
    size: 901px 637px;
    margin: 0;
}}

html, body {{
    margin: 0;
    padding: 0;
    width: 901px;
    background: white;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}}

.page-wrapper {{
    position: relative;
    width: 901px;
    height: 637px;
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
    overflow: hidden;
    background: white;
}}

.page-wrapper:last-child {{
    page-break-after: avoid;
    break-after: avoid;
}}

.outer_page {{
    position: relative;
    display: block;
    width: 901px;
    height: 637px;
    overflow: hidden;
    background: white;
}}

.newpage {{
    white-space: nowrap;
    position: relative;
    top: 0;
    left: 0;
    text-rendering: auto;
    color: #000;
}}

.image_layer {{
    width: 0;
    height: 0;
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
}}

.image_layer .absimg {{
    position: absolute;
    pointer-events: none;
    border: none;
    left: 0;
    -webkit-user-drag: none;
}}

.link_layer, .text_layer {{
    width: 0;
    height: 0;
    position: absolute;
    top: 0;
    left: 0;
    z-index: 2;
}}

.text_layer div, .text_layer span {{
    white-space: nowrap;
    padding: 0;
    margin: 0;
    border: none;
    line-height: 1;
}}

.text_layer span {{ height: 1px; }}

.text_layer span.a, .text_layer span.g {{
    position: absolute;
    border: none;
    left: 0;
}}

.text_layer span.w {{
    white-space: nowrap;
    padding: 0;
    margin: 0;
    border: none;
    height: 1px;
    line-height: 1;
    display: inline-block;
}}

.text_layer a.ll {{
    position: absolute;
    display: block;
    color: inherit;
    text-decoration: none;
}}

.text_layer span.l {{ margin: 0; }}
.text_layer span.l, .text_layer span.l1, .text_layer span.l2, .text_layer span.l3,
.text_layer span.l4, .text_layer span.l5, .text_layer span.l6, .text_layer span.l7,
.text_layer span.l8, .text_layer span.l9, .text_layer span.l10, .text_layer span.l11,
.text_layer span.l12 {{
    white-space: nowrap;
    padding: 0;
    border: none;
    height: 1px;
    line-height: 1;
    display: inline;
}}

.text_layer span.w1, .text_layer span.w2, .text_layer span.w3, .text_layer span.w4,
.text_layer span.w5, .text_layer span.w6, .text_layer span.w7, .text_layer span.w8,
.text_layer span.w9, .text_layer span.w10, .text_layer span.w11, .text_layer span.w12 {{
    white-space: nowrap;
    padding: 0;
    margin: 0;
    border: none;
    height: 1px;
    line-height: 1;
    display: inline-block;
}}

{w_css}
{l_css}
</style>
</head>
<body>
{''.join(pages_html_list)}
</body>
</html>
"""

    temp_html_path = os.path.join(output_dir, "temp_render.html")
    with open(temp_html_path, "w", encoding="utf-8") as f:
        f.write(compiled_html)

    safe_name = clean_filename(title)
    pdf_filename = f"{safe_name}.pdf"
    pdf_path = os.path.join(output_dir, pdf_filename)

    if progress_cb: progress_cb("Đang dùng Chrome kết xuất file PDF vector...", 90)

    # Run Chrome Headless
    chrome_cmd = [
        CHROME_PATH,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        temp_html_path
    ]
    subprocess.run(chrome_cmd, check=True)

    if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) == 0:
        raise RuntimeError("Kết xuất file PDF thất bại.")

    if progress_cb: progress_cb("Hoàn tất kết xuất file PDF!", 100)

    return {
        "success": True,
        "title": title,
        "filename": pdf_filename,
        "pdf_path": pdf_path,
        "file_size": os.path.getsize(pdf_path),
        "page_count": len(pages_html_list)
    }
