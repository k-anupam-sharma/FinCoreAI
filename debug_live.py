import os
import requests
from dotenv import load_dotenv

load_dotenv()
api_key = os.environ.get("NVIDIA_API_KEY")

if not api_key:
    print("No NVIDIA_API_KEY found.")
    exit(1)

headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}

payload = {
    "model": "meta/muse-glimmer-30b",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 10
}

print(f"Testing API with key starting with {api_key[:10]}...")

try:
    print("Sending request without tools...")
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=5)
    print(res.status_code)
    print(res.text[:200])
except Exception as e:
    print("Error without tools:", e)

payload_tools = {
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
    print("\nSending request WITH tools...")
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload_tools, timeout=5)
    print(res.status_code)
    print(res.text[:200])
except Exception as e:
    print("Error with tools:", e)
