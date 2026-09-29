import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()
api_key = os.environ.get("NVIDIA_API_KEY")

import sys
sys.path.append(os.getcwd())
from bot import tools

headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}

payload = {
    "model": "meta/llama-3.2-11b-vision-instruct",
    "messages": [{"role": "user", "content": "What is the status of PO0004?"}],
    "max_tokens": 100,
    "tools": tools,
    "tool_choice": "auto"
}

print(f"Testing with {len(tools)} tools...")
try:
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=5)
    print("Status:", res.status_code)
except Exception as e:
    print("Error:", e)
