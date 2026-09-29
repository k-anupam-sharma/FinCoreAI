import os
from openai import OpenAI
from dotenv import load_dotenv
import time

load_dotenv()
client = OpenAI(
  base_url="https://integrate.api.nvidia.com/v1",
  api_key=os.environ.get("NVIDIA_API_KEY")
)

try:
    print("Testing connection...")
    start = time.time()
    response = client.chat.completions.create(
        model="meta/muse-glimmer-30b",
        messages=[{"role": "user", "content": "Hello"}],
        max_tokens=10
    )
    print("Response received in", time.time() - start, "seconds.")
    print(response.choices[0].message.content)
except Exception as e:
    print("Error:", e)
