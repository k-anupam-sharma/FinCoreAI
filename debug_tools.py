import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()
api_key = os.environ.get("NVIDIA_API_KEY")

headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}

payload = {
    "model": "meta/llama-3.2-11b-vision-instruct",
    "messages": [{"role": "user", "content": "What is the status of PO0004?"}],
    "max_tokens": 100,
    "tools": [{
        "type": "function",
        "function": {
            "name": "get_purchase_order",
            "description": "Get purchase order info",
            "parameters": {
                "type": "object", 
                "properties": {
                    "po_id": {"type": "string"}
                },
                "required": ["po_id"]
            }
        }
    }],
    "tool_choice": "auto"
}

try:
    res = requests.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=10)
    print("Status:", res.status_code)
    try:
        data = res.json()
        print("Message:", json.dumps(data["choices"][0]["message"], indent=2))
    except Exception as e:
        print("Text:", res.text)
except Exception as e:
    print("Error:", e)
