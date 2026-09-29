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
    "messages": [
        {"role": "user", "content": "What is the status of PO0004?"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "chatcmpl-tool-1234",
                    "type": "function",
                    "function": {
                        "name": "get_purchase_order",
                        "arguments": "{\"po_id\": \"PO0004\"}"
                    }
                }
            ]
        },
        {
            "role": "tool",
            "tool_call_id": "chatcmpl-tool-1234",
            "name": "get_purchase_order",
            "content": "PO PO0004: Ordered 104 of PROD180 from SUP026 on 2025-05-01. Total Cost: 3155180.08"
        }
    ],
    "max_tokens": 100
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
