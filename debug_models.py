import os
import requests
from dotenv import load_dotenv

load_dotenv()
headers = {"Authorization": f"Bearer {os.environ.get('NVIDIA_API_KEY')}"}
res = requests.get("https://integrate.api.nvidia.com/v1/models", headers=headers)
print(res.status_code)
try:
    models = res.json()["data"]
    print([m["id"] for m in models][:10])
except:
    print(res.text)
