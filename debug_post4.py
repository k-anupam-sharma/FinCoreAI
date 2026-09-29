import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()
headers = {
    "Authorization": f"Bearer {os.environ.get('NVIDIA_API_KEY')}",
    "Content-Type": "application/json"
}
payload = {
    "model": "meta/muse-glimmer-30b",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 10,
    "tools": [{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    }]
}
try:
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=5)
    print(res.status_code)
    print(res.text)
except Exception as e:
    print("Error with tools:", e)

payload_no_tools = {
    "model": "meta/muse-glimmer-30b",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 10
}
try:
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload_no_tools, timeout=5)
    print("Without tools:", res.status_code)
except Exception as e:
    print("Error without tools:", e)

