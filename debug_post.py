import os
import requests
from dotenv import load_dotenv

load_dotenv()
headers = {
    "Authorization": f"Bearer {os.environ.get('NVIDIA_API_KEY')}",
    "Content-Type": "application/json"
}
payload = {
    "model": "meta/muse-glimmer-30b",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 10
}
try:
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=10)
    print(res.status_code)
    print(res.text)
except Exception as e:
    print("Error:", e)
