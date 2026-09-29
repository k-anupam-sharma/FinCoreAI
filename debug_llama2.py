import os
import requests
from dotenv import load_dotenv

load_dotenv()
api_key = os.environ.get("NVIDIA_API_KEY")

headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}
payload = {
    "model": "meta/llama-3.2-11b-vision-instruct",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 10
}
try:
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=5)
    print(res.status_code)
    print(res.text[:200])
except Exception as e:
    print("Error:", e)
