import os
import uuid
import threading
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

@app.route('/api/convert', methods=['POST'])
def convert():
    data = request.get_json() or {}
    url = data.get('url', '').strip()

    if not url:
        return jsonify({"success": False, "error": "Vui lòng nhập link Scribd hợp lệ."}), 400

    if "scribd.com" not in url:
        return jsonify({"success": False, "error": "Link không phải là link tài liệu từ Scribd.com."}), 400

    try:
        token = str(uuid.uuid4())
        task_output_dir = os.path.join(DOWNLOAD_DIR, token)
        os.makedirs(task_output_dir, exist_ok=True)

        res = convert_scribd_url_to_pdf(url, task_output_dir)

        token_store[token] = {
            "path": res["pdf_path"],
            "filename": res["filename"]
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
        return "File không tồn tại hoặc đã hết hạn.", 404

    return send_file(
        item["path"],
        as_attachment=True,
        download_name=item["filename"],
        mimetype="application/pdf"
    )

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5050))
    print(f"Scribd PDF Downloader server running on http://127.0.0.1:{port}")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)

