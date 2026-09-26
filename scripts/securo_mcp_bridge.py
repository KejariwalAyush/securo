#!/usr/bin/env python3
"""Securo MCP Stdio Bridge.

Reads JSON-RPC 2.0 messages from stdin, forwards them to Securo's HTTP MCP server
(http://localhost:8765/mcp), and writes responses back to stdout.

Allows tools like Gemini CLI, Claude Desktop, Cursor, or Antigravity to connect
via stdio.

Usage:
    python3 scripts/securo_mcp_bridge.py
"""
import json
import os
import sys
import urllib.request

MCP_URL = os.getenv("SECURO_MCP_URL", "http://localhost:8765/mcp")
MCP_TOKEN = os.getenv(
    "SECURO_MCP_TOKEN",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwNDdmODRmNi0xMjZmLTQ5NjctODJlOC0zYmE3NDcwZGI1MGUiLCJpc3MiOiJzZWN1cm8tYmFja2VuZCIsImF1ZCI6InNlY3Vyby1tY3AiLCJpYXQiOjE3OTA0MDYyNjgsImV4cCI6MTc5ODE4MjI2OCwid3NfaWQiOiI3MjEwYTIxMy0wZjkyLTRhYjctYTNmYS0yNzc1ZGE5MzQ1NzIiLCJleHQiOnRydWV9.OOu7mxNZwmC3ZheEEUsdqS0x1TSxZbezEg51sA917AI"
)

def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        try:
            req_data = line.encode("utf-8")
            req = urllib.request.Request(
                MCP_URL,
                data=req_data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {MCP_TOKEN}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_data = resp.read().decode("utf-8")
                sys.stdout.write(resp_data + "\n")
                sys.stdout.flush()
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            sys.stdout.write(err_body + "\n")
            sys.stdout.flush()
        except Exception as e:
            err_resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": str(e)},
            }
            sys.stdout.write(json.dumps(err_resp) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
