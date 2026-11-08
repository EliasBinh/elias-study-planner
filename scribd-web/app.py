import os
import uuid
import time
import shutil
import threading
import urllib.request
from flask import Flask, render_template, request, jsonify, send_file
from scribd_engine import convert_scribd_url_to_pdf

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_DIR = os.path.join(BASE_DIR, "downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Store tokens for downloads
token_store = {}

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/ping')
@app.route('/health')
def ping():
    return jsonify({"status": "ok", "timestamp": int(time.time())}), 200

@app.route('/api/convert', methods=['POST'])
def convert():
    data = request.get_json() or {}
    url = data.get('url', '').strip()

    if not url:
        return jsonify({"success": False, "error": "Please enter a valid Scribd URL."}), 400

    if "scribd.com" not in url:
        return jsonify({"success": False, "error": "This is not a valid Scribd document link."}), 400

    try:
        token = str(uuid.uuid4())
        task_output_dir = os.path.join(DOWNLOAD_DIR, token)
        os.makedirs(task_output_dir, exist_ok=True)

        res = convert_scribd_url_to_pdf(url, task_output_dir)

        token_store[token] = {
            "path": res["pdf_path"],
            "filename": res["filename"],
            "created_at": time.time()
        }

        return jsonify({
            "success": True,
            "title": res["title"],
            "filename": res["filename"],
            "file_size": res["file_size"],
            "pages": res["page_count"],
            "download_url": f"/download/{token}"
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/download/<token>', methods=['GET'])
def download(token):
    item = token_store.get(token)
    if not item or not os.path.exists(item["path"]):
        return "File not found or expired.", 404

    return send_file(
        item["path"],
        as_attachment=True,
        download_name=item["filename"],
        mimetype="application/pdf"
    )

def _keep_alive_loop():
    """Periodically ping self if RENDER_EXTERNAL_URL or SELF_PING_URL is provided."""
    target_url = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("SELF_PING_URL")
    if not target_url:
        return

    ping_endpoint = target_url.rstrip("/") + "/ping"
    print(f"[Keep-Alive] Configured for: {ping_endpoint}")
    # Wait 60s before initial ping
    time.sleep(60)

    while True:
        try:
            req = urllib.request.Request(ping_endpoint, headers={"User-Agent": "Render-KeepAlive/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                print(f"[Keep-Alive] Ping {ping_endpoint} -> {resp.status}")
        except Exception as err:
            print(f"[Keep-Alive] Ping error: {err}")
        time.sleep(10 * 60)  # Ping every 10 mins (Render sleeps at 15m)

def _cleanup_loop():
    """Remove files older than 1 hour to prevent disk overflow."""
    while True:
        try:
            now = time.time()
            if os.path.exists(DOWNLOAD_DIR):
                for item in os.listdir(DOWNLOAD_DIR):
                    item_path = os.path.join(DOWNLOAD_DIR, item)
                    if os.path.isdir(item_path):
                        if now - os.path.getmtime(item_path) > 3600:
                            shutil.rmtree(item_path, ignore_errors=True)
                    elif os.path.isfile(item_path):
                        if now - os.path.getmtime(item_path) > 3600:
                            try:
                                os.remove(item_path)
                            except OSError:
                                pass
        except Exception as e:
            print(f"[Cleanup] Error: {e}")
        time.sleep(15 * 60)

# Start background workers
threading.Thread(target=_keep_alive_loop, daemon=True).start()
threading.Thread(target=_cleanup_loop, daemon=True).start()

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5050))
    print(f"Scribd PDF Downloader server running on http://127.0.0.1:{port}")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
