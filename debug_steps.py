import os
import sys

os.chdir(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot")
sys.path.append(os.getcwd())

from bot import client, tools
from data_manager import get_purchase_order

print("1. Sending first request to Nvidia...")
messages = [
    {"role": "system", "content": "You are a helpful SME WhatsApp Bot assistant."},
    {"role": "user", "content": "What is the total cost for purchase order PO0004, and how many units were ordered?"}
]
response = client.chat.completions.create(
    model="meta/llama-3.2-11b-vision-instruct",
    messages=messages,
    tools=tools,
    tool_choice="auto"
)
print("2. Received response.")
response_message = response.choices[0].message
print("Tool calls:", response_message.tool_calls)

if response_message.tool_calls:
    messages.append(response_message)
    for tool_call in response_message.tool_calls:
        func_res = get_purchase_order("PO0004")
        print("3. Function returned:", func_res)
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": tool_call.function.name,
            "content": func_res
        })
    print("4. Sending second request...")
    second = client.chat.completions.create(
        model="meta/llama-3.2-11b-vision-instruct",
        messages=messages
    )
    print("5. Done! Reply:", repr(second.choices[0].message.content))
