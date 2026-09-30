import os
import json
import re
from openai import OpenAI
import data_manager
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(
  base_url="https://integrate.api.nvidia.com/v1",
  api_key=os.environ.get("NVIDIA_API_KEY", ""),
  timeout=30.0
)

import bot
tools = bot.tools

messages = [
    {"role": "system", "content": bot.conversations.get("default", [{"content": "You are a helpful..."}])[0]["content"]},
    {"role": "user", "content": "What is the status of invoice GST-3525-26?"}
]

for iteration in range(3):
    print(f"\n--- ITERATION {iteration} ---")
    response = client.chat.completions.create(
        model="meta/llama-3.2-11b-vision-instruct",
        messages=messages,
        tools=tools,
        tool_choice="auto"
    )
    
    response_message = response.choices[0].message
    tool_calls = response_message.tool_calls
    print(f"Tool calls: {tool_calls}")
    print(f"Content: {response_message.content}")
    
    hallucinated_tool = None
    if not tool_calls and response_message.content:
        try:
            match = re.search(r'\{.*\}', response_message.content.replace('\n', ''))
            if match:
                parsed = json.loads(match.group(0))
                if isinstance(parsed, dict) and "name" in parsed:
                    hallucinated_tool = parsed
                    print(f"Hallucinated tool: {hallucinated_tool}")
        except:
            pass

    if tool_calls or hallucinated_tool:
        messages.append(response_message)
        
        tool_results = []
        if tool_calls:
            for tool_call in tool_calls:
                function_name = tool_call.function.name
                function_args = json.loads(tool_call.function.arguments)
                tool_results.append((tool_call.id, function_name, function_args))
        elif hallucinated_tool:
            function_name = hallucinated_tool.get("name")
            function_args = hallucinated_tool.get("parameters", {})
            tool_results.append(("hallucinated_123", function_name, function_args))
            
        for tool_call_id, function_name, function_args in tool_results:
            
            if function_name == "get_invoice_status":
                function_response = data_manager.get_invoice_status(function_args.get("invoice_id", ""))
            else:
                function_response = "Error: Unknown function."
                
            new_msg = {
                "role": "user" if tool_call_id == "hallucinated_123" else "tool",
                "name": function_name,
                "content": f"Tool response: {str(function_response)}" if tool_call_id == "hallucinated_123" else str(function_response),
            }
            if tool_call_id != "hallucinated_123":
                new_msg["tool_call_id"] = tool_call_id
            print(f"Appending tool response: {new_msg}")
            messages.append(new_msg)
        
        continue
        
    print(f"FINAL REPLY: {response_message.content}")
    break
