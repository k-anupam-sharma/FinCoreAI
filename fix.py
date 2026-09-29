import json
import re

def fix_bot_py():
    with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "r", encoding="utf-8") as f:
        content = f.read()
    
    # 1. Add get_table_count to tools
    tool_def = """    {
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
]"""
    
    content = content.replace("    }\n]", tool_def)
    
    # 2. Add elif for get_table_count
    elif_def = """                elif function_name == "get_product_info":
                    function_response = data_manager.get_product_info(function_args.get("query", ""))
                elif function_name == "get_table_count":
                    function_response = data_manager.get_table_count(function_args.get("table_name", ""))"""
    
    content = content.replace("""                elif function_name == "get_product_info":
                    function_response = data_manager.get_product_info(function_args.get("query", ""))""", elif_def)
                    
    # 3. Improve json hallucination parsing
    old_json = """        if not tool_calls and response_message.content:
            try:
                parsed = json.loads(response_message.content.strip())"""
    new_json = """        if not tool_calls and response_message.content:
            try:
                content_clean = response_message.content.strip()
                # Remove markdown backticks if present
                if content_clean.startswith("```json"):
                    content_clean = content_clean[7:]
                if content_clean.startswith("```"):
                    content_clean = content_clean[3:]
                if content_clean.endswith("```"):
                    content_clean = content_clean[:-3]
                
                parsed = json.loads(content_clean.strip())"""
    
    content = content.replace(old_json, new_json)
    
    with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "w", encoding="utf-8") as f:
        f.write(content)
        
fix_bot_py()
