# -*- coding: utf-8 -*-
"""
JKH Desktop Launcher (single entry for PyInstaller)

- GUI mode (default): starts local server by spawning THIS executable/script with --server
- Server mode (--server): runs Flask app via Waitress, serves ./web and minimal /api endpoints

Target: Windows 7 / Windows 10 (build with Python 3.8.x)
"""
import os
import sys
import json
import time
import socket
import subprocess
import webbrowser
from pathlib import Path

def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

def load_config() -> dict:
    p = base_dir() / "config" / "app.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"app_name":"JKH Desktop","host":"127.0.0.1","port":8765,"port_range":[8765,8790],"web_index":"index.html","open_browser":True}

def pick_free_port(host: str, port_range):
    start, end = int(port_range[0]), int(port_range[1])
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.2)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    return None

def wait_for_health(url: str, timeout_s: float = 8.0) -> bool:
    import urllib.request
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            with urllib.request.urlopen(url, timeout=0.7) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False

def run_server(host: str, port: int):
    from waitress import serve
    from flask import Flask, send_from_directory, jsonify

    cfg = load_config()
    web_root = (base_dir() / "web").resolve()
    index_file = cfg.get("web_index", "index.html")

    app = Flask(__name__, static_folder=None)

    @app.get("/api/health")
    def api_health():
        return jsonify({"status":"ok","app":cfg.get("app_name","JKH Desktop"),"port":port})

    @app.get("/api/config")
    def api_config():
        return jsonify({"app_name": cfg.get("app_name","JKH Desktop"), "host": host, "port": port, "web_index": index_file})

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_web(path: str):
        if path == "" or path.endswith("/"):
            path = index_file
        full = (web_root / path).resolve()
        if not str(full).startswith(str(web_root)):
            return ("Not found", 404)
        if full.is_dir():
            full = (full / index_file).resolve()
        if full.exists():
            return send_from_directory(str(full.parent), full.name)
        idx = (web_root / index_file)
        if idx.exists():
            return send_from_directory(str(idx.parent), idx.name)
        return ("web_index not found", 500)

    serve(app, host=host, port=int(port))

def gui_main():
    import tkinter as tk
    from tkinter import messagebox

    cfg = load_config()
    host = cfg.get("host","127.0.0.1")
    port_range = cfg.get("port_range",[8765,8790])

    state = {"proc": None, "port": None}

    def start_server():
        if state["proc"] and state["proc"].poll() is None:
            messagebox.showinfo("JKH Desktop", "Сервер уже запущен.")
            return
        p = pick_free_port(host, port_range)
        if p is None:
            messagebox.showerror("JKH Desktop", "Не удалось найти свободный порт.")
            return

        exe = str(sys.executable)
        if getattr(sys, "frozen", False):
            args = [exe, "--server", "--host", host, "--port", str(p)]
        else:
            args = [exe, str(Path(__file__).resolve()), "--server", "--host", host, "--port", str(p)]

        logs_dir = base_dir() / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        out_f = open(logs_dir / "server_stdout.log", "a", encoding="utf-8", errors="ignore")
        err_f = open(logs_dir / "server_stderr.log", "a", encoding="utf-8", errors="ignore")

        try:
            proc = subprocess.Popen(args, stdout=out_f, stderr=err_f, cwd=str(base_dir()))
        except Exception as e:
            messagebox.showerror("JKH Desktop", f"Не удалось запустить сервер:\n{e}")
            return

        state["proc"] = proc
        state["port"] = p

        ok = wait_for_health(f"http://{host}:{p}/api/health", timeout_s=8.0)
        url = f"http://{host}:{p}/"
        if not ok:
            messagebox.showerror("JKH Desktop", "Сервер не ответил. Открой logs/server_stderr.log")
            return

        status_var.set(f"Запущено: {url}")
        if cfg.get("open_browser", True):
            webbrowser.open(url)

    def stop_server():
        proc = state.get("proc")
        if not proc or proc.poll() is not None:
            status_var.set("Остановлено")
            return
        try:
            proc.terminate()
        except Exception:
            pass
        time.sleep(0.4)
        status_var.set("Остановлено")

    def open_app():
        if not state.get("port"):
            messagebox.showinfo("JKH Desktop", "Сначала нажми «Запустить».")
            return
        webbrowser.open(f"http://{host}:{state['port']}/")

    def open_logs():
        logs_dir = base_dir() / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        os.startfile(str(logs_dir))

    rootw = tk.Tk()
    rootw.title(cfg.get("app_name","JKH Desktop"))
    rootw.geometry("420x220")
    rootw.resizable(False, False)

    frm = tk.Frame(rootw, padx=12, pady=12)
    frm.pack(fill="both", expand=True)

    tk.Label(frm, text=cfg.get("app_name","JKH Desktop"), font=("Segoe UI", 12, "bold")).pack(anchor="w")

    status_var = tk.StringVar(value="Остановлено")
    tk.Label(frm, textvariable=status_var, wraplength=390).pack(anchor="w", pady=(8,12))

    btns = tk.Frame(frm)
    btns.pack(anchor="w")

    tk.Button(btns, text="Запустить", width=12, command=start_server).grid(row=0, column=0, padx=(0,8), pady=4)
    tk.Button(btns, text="Открыть", width=12, command=open_app).grid(row=0, column=1, padx=(0,8), pady=4)
    tk.Button(btns, text="Остановить", width=12, command=stop_server).grid(row=0, column=2, padx=(0,8), pady=4)

    tk.Button(frm, text="Открыть папку logs", command=open_logs).pack(anchor="w", pady=(10,0))

    def on_close():
        try:
            stop_server()
        finally:
            rootw.destroy()

    rootw.protocol("WM_DELETE_WINDOW", on_close)
    rootw.mainloop()

def main():
    if "--server" in sys.argv:
        cfg = load_config()
        host = cfg.get("host","127.0.0.1")
        port = int(cfg.get("port",8765))
        if "--host" in sys.argv:
            host = sys.argv[sys.argv.index("--host")+1]
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port")+1])
        run_server(host, port)
    else:
        gui_main()

if __name__ == "__main__":
    main()
