import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(
  base_url="https://integrate.api.nvidia.com/v1",
  api_key=os.environ.get("NVIDIA_API_KEY", "")
)

messages = [
    {"role": "system", "content": "You are a helpful and intelligent SME WhatsApp Bot... (rest of system prompt)"},
    {"role": "user", "content": "what if I order 140 Global Desi Palazzo sets instead of 138? how will it affect my sales?"},
    {"role": "assistant", "content": "{\"name\": \"get_product_info\", \"parameters\": {\"query\": \"Global Desi Palazzo\"}}"},
    {"role": "user", "content": "Tool response: Product PROD076: Global Desi Palazzo Set (Category: CAT002, Price: Rs.4500, Supplier: SUP036 (Dar-Wason))"}
]

response = client.chat.completions.create(
    model="meta/llama-3.2-11b-vision-instruct",
    messages=messages
)
print("SECOND RESPONSE:")
print(response.choices[0].message.content)
