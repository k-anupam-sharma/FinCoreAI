import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(
  base_url="https://integrate.api.nvidia.com/v1",
  api_key=os.environ.get("NVIDIA_API_KEY"),
  timeout=5
)

try:
    print("Testing connection...")
    response = client.chat.completions.create(
        model="meta/muse-glimmer-30b",
        messages=[{"role": "user", "content": "Hello"}],
        max_tokens=10
    )
    print("Response received!")
except Exception as e:
    print("Error:", e)
