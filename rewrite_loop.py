import re

with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "r", encoding="utf-8") as f:
    content = f.read()

old_func = """    try:
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
                # Find JSON block in the text
                match = re.search(r'\{.*\}', response_message.content.replace('\n', ''))
                if match:
                    parsed = json.loads(match.group(0))
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
                elif function_name == "get_product_info" or function_name == "get_product_price":
                    query = function_args.get("query") or function_args.get("product_id") or function_args.get("product_code") or ""
                    function_response = data_manager.get_product_info(query)
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
"""

new_func = """    try:
        # Loop for a maximum of 3 tool call iterations
        for iteration in range(3):
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
                    # Find JSON block in the text
                    match = re.search(r'\\{.*\\}', response_message.content.replace('\\n', ''))
                    if match:
                        parsed = json.loads(match.group(0))
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
                    elif function_name == "get_product_info" or function_name == "get_product_price":
                        query = function_args.get("query") or function_args.get("product_id") or function_args.get("product_code") or ""
                        function_response = data_manager.get_product_info(query)
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
                
                # Continue the loop to let the model generate the next response
                continue
                
            # If no tool calls were made, this is the final reply
            final_reply = response_message.content
            
            # Sometimes hallucinated tools leave JSON residue in the content string if it wasn't valid.
            # But if we reach here, it means no valid tool was parsed.
            conversations[user_id].append({"role": "assistant", "content": final_reply})
            return final_reply
            
        return "I am unable to process your request after multiple attempts."
    except Exception as e:
        print(f"Error: {e}")
        return f"Sorry, I ran into an error while processing your request: {str(e)}"
"""

if old_func in content:
    content = content.replace(old_func, new_func)
    with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "w", encoding="utf-8") as f:
        f.write(content)
    print("SUCCESS")
else:
    print("FAILED TO MATCH")
