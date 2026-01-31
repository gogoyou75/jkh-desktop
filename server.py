import os
from pathlib import Path
from flask import Flask, jsonify, send_from_directory

def create_app(root_path=None):
    if root_path is None:
        root_path = Path(__file__).resolve().parents[1]
    else:
        root_path = Path(root_path)

    web_dir = root_path / "web"
    data_dir = root_path / "data"
    logs_dir = root_path / "logs"

    web_dir.mkdir(exist_ok=True)
    data_dir.mkdir(exist_ok=True)
    logs_dir.mkdir(exist_ok=True)

    app = Flask(
        __name__,
        static_folder=str(web_dir),
        static_url_path="/static"
    )

    @app.route("/")
    def index():
        return send_from_directory(web_dir, "index.html")

    @app.route("/<path:path>")
    def static_files(path):
        file_path = web_dir / path
        if file_path.exists():
            return send_from_directory(web_dir, path)
        return ("Not Found", 404)

    @app.route("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "app": "JKH Desktop"
        })

    @app.errorhandler(404)
    def not_found(e):
        return jsonify({"error": "not_found"}), 404

    return app
