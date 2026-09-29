import os
import json
import requests
import base64
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import Response
from openai import OpenAI
import data_manager

load_dotenv()

app = FastAPI()
client = OpenAI(
  base_url="https://integrate.api.nvidia.com/v1",
  api_key=os.environ.get("NVIDIA_API_KEY", ""),
  timeout=30.0
)

# Meta Configuration
VERIFY_TOKEN = os.environ.get("META_VERIFY_TOKEN", "my_secure_verify_token")
WHATSAPP_TOKEN = os.environ.get("META_WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.environ.get("META_PHONE_NUMBER_ID", "")

# Define tools for Groq
tools = [
    {
        "type": "function",
        "function": {
            "name": "check_inventory",
            "description": "Check the current stock and reorder point for a specific product ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "product_id": {
                        "type": "string",
                        "description": "The Product ID, e.g., 'PROD001'"
                    }
                },
                "required": ["product_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_total_sales",
            "description": "Get the total sum of all sales made to date.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "add_expense",
            "description": "Add a new expense record.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expense_code": {
                        "type": "string",
                        "description": "The category/code of the expense, e.g., RENT, SALARY, ELECTRICITY"
                    },
                    "amount": {
                        "type": "number",
                        "description": "The amount spent"
                    },
                    "description": {
                        "type": "string",
                        "description": "A short description of the expense"
                    }
                },
                "required": ["expense_code", "amount", "description"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_invoice_status",
            "description": "Check the status and total value of an invoice by its ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "invoice_id": {
                        "type": "string",
                        "description": "The Invoice ID, e.g., 'INV00001'"
                    }
                },
                "required": ["invoice_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_customer_info",
            "description": "Search for a customer's details by their ID or name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The Customer ID (e.g., 'CUST0001') or Name"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_purchase_order",
            "description": "Get details of a purchase order by PO_ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "po_id": {
                        "type": "string",
                        "description": "The Purchase Order ID (e.g., 'PO0001')"
                    }
                },
                "required": ["po_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "check_pending_payments",
            "description": "Check pending payments for a specific customer or get the top 5 overdue payments.",
            "parameters": {
                "type": "object",
                "properties": {
                    "customer_query": {
                        "type": "string",
                        "description": "The Customer ID or Name to check. Leave empty to get the overall top 5 overdue payments."
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_supplier_info",
            "description": "Search for a supplier's details (contact, category, reliability) by their ID or name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The Supplier ID (e.g., 'SUP001') or Name"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_product_info",
            "description": "Search for a product's details (price, category) by their ID or name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The Product ID (e.g., 'PROD001') or Name"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_table_count",
            "description": "Count the number of records in a specific table (e.g. to answer 'how many suppliers' or 'how many customers').",
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {
                        "type": "string",
                        "description": "The table to count (e.g., 'suppliers', 'customers', 'products', 'inventory', 'purchase_orders', 'invoices', 'pending_payments', 'expenses')"
                    }
                },
                "required": ["table_name"]
            }
        }
    }
]

# In-memory conversational context (Phone Number -> List of messages)
conversations = {}

def process_message(message: str, user_id: str = "default") -> str:
    # Initialize history for this user if it doesn't exist
    if user_id not in conversations:
        conversations[user_id] = [
            {"role": "system", "content": "You are a helpful and intelligent SME WhatsApp Bot. IMPORTANT RULES: 1. You MUST ALWAYS use tools to fetch real data when the user asks about specific orders, products, customers, or suppliers. ONLY use the provided tools, do not hallucinate tool names. 2. You are an internal business assistant. You MUST think step by step to answer internal business and financial questions (e.g. sales estimates, profit calculations) using the company data. Provide proper statistical data and calculations when estimating impact. 3. You MUST politely refuse to answer questions completely unrelated to the business. 4. NEVER show SQL queries in your response. 5. Always show the item name along with the item ID in brackets beside it (e.g., 'Palazzo Set (PROD076)')."}
        ]
    
    # Append the new user message to their specific history
    conversations[user_id].append({"role": "user", "content": message})
    
    # Keep only the last 10 messages (plus the system prompt) to avoid hitting token limits
    if len(conversations[user_id]) > 11:
        conversations[user_id] = [conversations[user_id][0]] + conversations[user_id][-10:]
        
    messages = conversations[user_id].copy()
    
    try:
        response = client.chat.completions.create(
            model="meta/llama-3.2-11b-vision-instruct",
            messages=messages,
            tools=tools,
            tool_choice="auto"
        )
        
        response_message = response.choices[0].message
        tool_calls = response_message.tool_calls
        
        # Fix for Llama occasionally outputting raw JSON instead of proper tool_calls
        hallucinated_tool = None
        if not tool_calls and response_message.content:
            try:
                content_clean = response_message.content.strip()
                # Remove markdown backticks if present
                if content_clean.startswith("```json"):
                    content_clean = content_clean[7:]
                if content_clean.startswith("```"):
                    content_clean = content_clean[3:]
                if content_clean.endswith("```"):
                    content_clean = content_clean[:-3]
                
                parsed = json.loads(content_clean.strip())
                if isinstance(parsed, dict) and "name" in parsed:
                    hallucinated_tool = parsed
            except:
                pass

        if tool_calls or hallucinated_tool:
            # Append the assistant's message with the tool call
            messages.append(response_message)
            
            # Handle standard tool calls
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
                
                if function_name == "check_inventory":
                    function_response = data_manager.check_inventory(function_args.get("product_id", ""))
                elif function_name == "get_total_sales":
                    function_response = data_manager.get_total_sales()
                elif function_name == "add_expense":
                    function_response = data_manager.add_expense(
                        function_args.get("expense_code", "MISC"), 
                        function_args.get("amount", 0), 
                        function_args.get("description", "")
                    )
                elif function_name == "get_invoice_status":
                    function_response = data_manager.get_invoice_status(function_args.get("invoice_id", ""))
                elif function_name == "get_customer_info":
                    function_response = data_manager.get_customer_info(function_args.get("query", ""))
                elif function_name == "get_purchase_order":
                    function_response = data_manager.get_purchase_order(function_args.get("po_id", ""))
                elif function_name == "check_pending_payments":
                    function_response = data_manager.check_pending_payments(function_args.get("customer_query"))
                elif function_name == "get_supplier_info":
                    function_response = data_manager.get_supplier_info(function_args.get("query", ""))
                elif function_name == "get_product_info":
                    function_response = data_manager.get_product_info(function_args.get("query", ""))
                elif function_name == "get_table_count":
                    function_response = data_manager.get_table_count(function_args.get("table_name", ""))
                else:
                    function_response = "Error: Unknown function."
                    
                new_msg = {
                    "role": "user" if tool_call_id == "hallucinated_123" else "tool",
                    "name": function_name,
                    "content": f"Tool response: {str(function_response)}" if tool_call_id == "hallucinated_123" else str(function_response),
                }
                if tool_call_id != "hallucinated_123":
                    new_msg["tool_call_id"] = tool_call_id
                messages.append(new_msg)
                
            # Second call to formulate the final answer based on the tool's result
            second_response = client.chat.completions.create(
                model="meta/llama-3.2-11b-vision-instruct",
                messages=messages
            )
            final_reply = second_response.choices[0].message.content
            conversations[user_id].append({"role": "assistant", "content": final_reply})
            return final_reply
            
        final_reply = response_message.content
        conversations[user_id].append({"role": "assistant", "content": final_reply})
        return final_reply
    except Exception as e:
        print(f"Error: {e}")
        return f"Sorry, I ran into an error while processing your request: {str(e)}"

def send_whatsapp_message(to_number: str, text: str):
    url = f"https://graph.facebook.com/v17.0/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": to_number,
        "type": "text",
        "text": {"body": text}
    }
    requests.post(url, headers=headers, json=payload)

def handle_invoice_image(media_id: str) -> str:
    # 1. Get media URL
    headers = {"Authorization": f"Bearer {WHATSAPP_TOKEN}"}
    url_res = requests.get(f"https://graph.facebook.com/v17.0/{media_id}", headers=headers)
    if url_res.status_code != 200:
        return f"Failed to get media info: {url_res.text}"
    
    media_url = url_res.json().get("url")
    if not media_url:
        return "Media URL not found in Meta response."
        
    # 2. Download media
    img_res = requests.get(media_url, headers=headers)
    if img_res.status_code != 200:
        return f"Failed to download image: {img_res.text}"
        
    # 3. Base64 encode
    encoded_string = base64.b64encode(img_res.content).decode('utf-8')
    
    # 4. OCR using Llama
    try:
        response = client.chat.completions.create(
            model="meta/llama-3.2-11b-vision-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text", 
                            "text": "Please extract the Invoice ID, Supplier Name, Date, and Total Amount from this invoice. Return ONLY a JSON object in this format: {\"invoice_id\": \"...\", \"supplier\": \"...\", \"date\": \"...\", \"total\": ...}"
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{encoded_string}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=200
        )
        ocr_result = response.choices[0].message.content
        
        # Parse JSON
        content_clean = ocr_result.strip()
        if content_clean.startswith("```json"):
            content_clean = content_clean[7:]
        if content_clean.startswith("```"):
            content_clean = content_clean[3:]
        if content_clean.endswith("```"):
            content_clean = content_clean[:-3]
            
        ocr_data = json.loads(content_clean.strip())
        
        # 5. Add invoice to DB
        return data_manager.process_invoice(
            ocr_data.get("invoice_id", "UNKNOWN"),
            ocr_data.get("supplier", "UNKNOWN"),
            ocr_data.get("date", "UNKNOWN"),
            ocr_data.get("total", 0)
        )
    except Exception as e:
        return f"Error processing invoice OCR: {str(e)}"

@app.get("/whatsapp")
async def verify_webhook(request: Request):
    """Meta webhook verification endpoint."""
    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")
    
    if mode == "subscribe" and token == VERIFY_TOKEN:
        return Response(content=challenge, status_code=200)
    return Response(content="Forbidden", status_code=403)

@app.post("/whatsapp")
async def receive_message(request: Request):
    """Endpoint to receive messages from Meta."""
    body = await request.json()
    
    try:
        # Validate it's a WhatsApp message event
        if "object" in body and body["object"] == "whatsapp_business_account":
            for entry in body.get("entry", []):
                for change in entry.get("changes", []):
                    value = change.get("value", {})
                    if "messages" in value:
                        # Extract the first message
                        msg_data = value["messages"][0]
                        sender_phone = msg_data["from"]
                        
                        if msg_data["type"] == "text":
                            msg_text = msg_data["text"]["body"]
                            
                            # Send message to Groq for processing
                            reply_text = process_message(msg_text, user_id=sender_phone)
                            
                            # Reply back using Meta Graph API
                            send_whatsapp_message(sender_phone, reply_text)
                            
                        elif msg_data["type"] == "image":
                            media_id = msg_data["image"]["id"]
                            reply_text = handle_invoice_image(media_id)
                            send_whatsapp_message(sender_phone, reply_text)
                            
    except Exception as e:
        print(f"Error processing Meta webhook: {e}")
        
    # Acknowledge receipt to Meta immediately
    return Response(content="OK", status_code=200)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

