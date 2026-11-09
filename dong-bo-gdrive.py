import os
import re
import json
import shutil
import urllib.request

ROOT_FOLDER_ID = "1PedZtrXvoC6zm14wodZdgPAXlSGJoyBU"  # Tháng 12
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_VERBAL = os.path.join(BASE_DIR, "data", "10SAT", "VERBAL")
USER_DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads", "10SAT", "VERBAL")
STAGING_DIR = os.path.join(BASE_DIR, "gdrive_downloads")

os.makedirs(REPO_VERBAL, exist_ok=True)
os.makedirs(USER_DOWNLOADS, exist_ok=True)
os.makedirs(STAGING_DIR, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def clean_key(name):
    """Normalize name to detect whether an assignment already exists."""
    s = name.lower()
    s = re.sub(r'^(final_|\[202\d\]\s*|\[others\]\s*)', '', s)
    s = re.sub(r'^\s*\[\d{1,2}[.-]\d{1,2}\]\s*\[verbal\]\s*', '', s)
    s = re.sub(r'^\s*chưa rõ\s*\[verbal\]\s*', '', s)
    s = re.sub(r'^\s*\[a\]\s*', '', s)
    s = re.sub(r'\s*\(review\)', '', s)
    s = re.sub(r'\.pdf$', '', s)
    s = re.sub(r'[\s\-_]+', ' ', s).strip()
    return s

def fetch_gdrive_folder(folder_id):
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    req = urllib.request.Request(url, headers=HEADERS)
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
    callbacks = re.findall(r'AF_initDataCallback\((.*?)\);</script>', html, re.DOTALL)
    for c in callbacks:
        if "data:" in c:
            m = re.search(r'data:\s*(\[.*?\])\s*,\s*sideChannel', c, re.DOTALL)
            if m:
                try:
                    data = json.loads(m.group(1))
                    if len(data) > 27 and len(data[27]) > 7 and data[27][7] and data[27][7][0]:
                        return data[27][7][0][0]
                except Exception:
                    pass
    return []

def download_file(file_id, dest_path):
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 1000:
        return True

    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            content = resp.read()
            if len(content) < 1000 and b"<!DOCTYPE html>" in content:
                confirm = re.findall(r'confirm=([0-9A-Za-z_]+)', content.decode('utf-8', 'ignore'))
                if confirm:
                    confirm_url = f"https://drive.google.com/uc?export=download&confirm={confirm[0]}&id={file_id}"
                    req2 = urllib.request.Request(confirm_url, headers=HEADERS)
                    with urllib.request.urlopen(req2, timeout=60) as resp2:
                        content = resp2.read()
            with open(dest_path, "wb") as f:
                f.write(content)
            return True
    except Exception as e:
        print(f"  [Lỗi tải] ID {file_id}: {e}")
        return False

def sync_all():
    print(f"[*] Đang quét thư mục Google Drive: {ROOT_FOLDER_ID}...")
    root_items = fetch_gdrive_folder(ROOT_FOLDER_ID)
    sessions = []
    for it in root_items:
        fid = it[0][1] if (len(it) > 0 and len(it[0]) > 1) else None
        name = None
        try:
            name = it[24][2][0][2][1][0][0][0]
        except Exception:
            pass
        if fid and name:
            sessions.append((name, fid))

    print(f"[+] Tìm thấy {len(sessions)} buổi học trên Drive.")

    existing_files = os.listdir(REPO_VERBAL)
    existing_keys = {clean_key(f): f for f in existing_files}
    total_added = 0

    for s_name, s_fid in sessions:
        s_items = fetch_gdrive_folder(s_fid)
        s_dir = os.path.join(STAGING_DIR, s_name)
        os.makedirs(s_dir, exist_ok=True)

        for it in s_items:
            fid = it[0][1] if (len(it) > 0 and len(it[0]) > 1) else None
            name = None
            try:
                name = it[24][2][0][2][1][0][0][0]
            except Exception:
                pass
            if not fid or not name:
                continue

            # Subfolder (e.g. Phiếu trên lớp)
            if not name.lower().endswith(".pdf"):
                sub_items = fetch_gdrive_folder(fid)
                for sub in sub_items:
                    sub_fid = sub[0][1] if (len(sub) > 0 and len(sub[0]) > 1) else None
                    sub_name = None
                    try:
                        sub_name = sub[24][2][0][2][1][0][0][0]
                    except Exception:
                        pass
                    if sub_fid and sub_name and sub_name.lower().endswith(".pdf"):
                        ck = clean_key(sub_name)
                        if ck in existing_keys:
                            continue
                        dest = os.path.join(s_dir, sub_name)
                        if download_file(sub_fid, dest):
                            target = f"[14.11] [Verbal] {sub_name}"
                            p_repo = os.path.join(REPO_VERBAL, target)
                            p_user = os.path.join(USER_DOWNLOADS, target)
                            shutil.copy2(dest, p_repo)
                            shutil.copy2(dest, p_user)
                            existing_keys[ck] = target
                            print(f"  [+ Bổ sung mới] {target}")
                            total_added += 1
                continue

            # Check if assignment already exists
            ck = clean_key(name)
            if ck in existing_keys:
                # Already exists, skip duplicate!
                continue

            # Check special case for words in context numbers
            wic_match = re.search(r'words in context\s*(\d+)', ck)
            if wic_match:
                num = wic_match.group(1)
                if any(f"words in context {num}" in k or f"words in context - {num}" in k for k in existing_keys):
                    continue

            clean_name = name.replace("/", "_").replace("\\", "_")
            dest = os.path.join(s_dir, clean_name)
            if download_file(fid, dest):
                target = f"Chưa rõ  [Verbal] {clean_name}"
                p_repo = os.path.join(REPO_VERBAL, target)
                p_user = os.path.join(USER_DOWNLOADS, target)
                shutil.copy2(dest, p_repo)
                shutil.copy2(dest, p_user)
                existing_keys[ck] = target
                print(f"  [+ Bổ sung mới] {target}")
                total_added += 1

    print(f"\n[XONG] Đồng bộ hoàn tất. Số file thêm mới: {total_added}")

    # Trigger server scan
    try:
        req = urllib.request.Request("http://127.0.0.1:8899/api/scan", data=b"", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            print("[Server] Đã làm mới hệ thống: " + resp.read().decode())
    except Exception:
        pass

if __name__ == "__main__":
    sync_all()
