import os
import requests
from dotenv import load_dotenv

load_dotenv()
headers = {"Authorization": f"Bearer {os.environ.get('NVIDIA_API_KEY')}"}
res = requests.get("https://integrate.api.nvidia.com/v1/models", headers=headers)
models = res.json()["data"]
for m in models:
    if "muse" in m["id"].lower():
        print(m)
