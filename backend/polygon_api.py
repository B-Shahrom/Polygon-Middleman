import hashlib
import random
import string
import time
import asyncio
from typing import Any

import httpx
import requests as sync_requests

POLYGON_BASE_URL = "https://polygon.codeforces.com/api"


def _to_str(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _build_api_sig(method: str, params: dict, secret: str) -> str:
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    sorted_params = sorted(params.items())
    params_str = "&".join(f"{k}={v}" for k, v in sorted_params)
    hash_input = f"{rand}/{method}?{params_str}#{secret}"
    hash_hex = hashlib.sha512(hash_input.encode("utf-8")).hexdigest()
    return f"{rand}{hash_hex}"


async def call_polygon(
    method: str,
    api_key: str,
    api_secret: str,
    params: dict | None = None,
    files: dict | None = None,
) -> tuple[bytes, str]:
    if params is None:
        params = {}

    params = {k: _to_str(v) for k, v in params.items() if v is not None}

    # polygon-cli approach: file content MUST be included in signature hash
    if files:
        for key, (filename, content, mime_type) in files.items():
            if isinstance(content, bytes):
                params[key] = content.decode("utf-8")
            else:
                params[key] = content

    params["apiKey"] = api_key
    params["time"] = str(int(time.time()))
    params["apiSig"] = _build_api_sig(method, params, api_secret)

    url = f"{POLYGON_BASE_URL}/{method}"

    if files:
        # polygon-cli approach: send ALL params via files= (not split data/files)
        all_parts: dict = {}
        for k, v in params.items():
            if k in files:
                # Send the actual file with its filename
                filename, content, mime_type = files[k]
                all_parts[k] = (filename, content, mime_type)
            else:
                all_parts[k] = (None, v)

        resp = await asyncio.to_thread(
            lambda: sync_requests.post(url, files=all_parts, timeout=120)
        )
        return resp.content, resp.headers.get("Content-Type", "application/octet-stream")
    else:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            response = await client.post(url, data=params)
        return response.content, response.headers.get("content-type", "application/octet-stream")
